const express = require('express');
const { PrismaClient } = require('@prisma/client');
const admin = require('firebase-admin');

// --- Centralized Configuration ---
const config = {
  port: process.env.PORT || 8080,
  host: '0.0.0.0', // Explicitly listen on all interfaces
  serverTimeout: 900000, // 15 minutes
  rateLimit: {
    messagesPerSecond: 50,
    batchSize: 100,
    retryAttempts: 2,
    retryDelay: 500,
    concurrentBatches: 3,
    pauseBetweenBatches: 100
  }
};

// --- Application Initialization ---
const app = express();
const prisma = new PrismaClient({
  log: ['error', 'warn'],
});

// --- Firebase Admin Initialization ---
try {
  if (!admin.apps.length) {
    const serviceAccount = process.env.FIREBASE_CREDENTIALS 
      ? JSON.parse(process.env.FIREBASE_CREDENTIALS)
      : undefined;
    
    admin.initializeApp(serviceAccount ? {
      credential: admin.credential.cert(serviceAccount),
    } : {});
    
    console.log('✅ Firebase Admin initialized successfully.');
  }
} catch (error) {
  console.warn("⚠️ Firebase initialization failed:", error.message);
}
const db = admin.firestore();

// --- Environment Variable Verification ---
const verifyEnvVariables = () => {
  console.log('🔍 Verifying required environment variables...');
  const requiredEnvVars = {
    META_ACCESS_TOKEN: 'Meta Business API Access Token',
    META_PHONE_NUMBER_ID: 'WhatsApp Phone Number ID',
    DATABASE_URL: 'Database Connection URL'
  };
  let allVarsPresent = true;
  for (const [key, description] of Object.entries(requiredEnvVars)) {
    if (process.env[key]) {
      console.log(`✅ ${key}: CONFIGURED`);
    } else {
      console.error(`❌ ${key}: MISSING - ${description}`);
      allVarsPresent = false;
    }
  }
  if (!allVarsPresent) {
    console.error('🚨 Critical environment variables are missing. The application may not function correctly. Shutting down.');
    process.exit(1);
  }
};

// --- Middleware Setup ---
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  next();
});
app.use((req, res, next) => {
  console.log(`➡️ ${req.method} ${req.path} - ${new Date().toISOString()}`);
  next();
});

// --- WhatsApp Campaign Manager Class ---
class WhatsAppCampaignManager {
    constructor() {
        this.rateLimiter = new Map();
    }

    async waitForRateLimit(campaignId) {
        const now = Date.now();
        const lastSent = this.rateLimiter.get(campaignId) || 0;
        const timeDiff = now - lastSent;
        const minInterval = 1000 / config.rateLimit.messagesPerSecond;

        if (timeDiff < minInterval) {
            const waitTime = minInterval - timeDiff;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        this.rateLimiter.set(campaignId, Date.now());
    }

    prepareMessagePayload(template, cliente, mappings, celularFormatted) {
        const bodyParams = [];
        const sortedIndices = Object.keys(mappings).sort((a, b) => parseInt(a) - parseInt(b));
        
        console.log(`🎯 [TEMPLATE_MODE] Using Meta Business template: ${template.nombre_template}`);
        
        for (const idx of sortedIndices) {
            const field = mappings[idx];
            let valor = cliente[field] ?? "";
            
            // Specific data cleaning
            if (typeof valor === 'string') {
                valor = valor.trim().replace(/,+$/, "");
            } else {
                valor = String(valor);
            }
            
            console.log(`📝 [PARAM_${idx}] ${field}: "${valor}"`);
            bodyParams.push({ type: "text", text: valor });
        }
        
        const payload = {
            messaging_product: "whatsapp",
            to: celularFormatted,
            type: "template",
            template: {
                name: template.nombre_template,
                language: { code: "es_PE" },
                components: bodyParams.length > 0 ? [{ type: "body", parameters: bodyParams }] : []
            }
        };
        
        console.log(`📦 [TEMPLATE_PAYLOAD] Final payload:`, JSON.stringify(payload, null, 2));
        return payload;
    }

    processMessageText(template, cliente, mappings) {
        const sortedIndices = Object.keys(mappings).sort((a, b) => parseInt(a) - parseInt(b));
        let texto = template.mensaje || `Template: ${template.nombre_template}`;
        
        for (const idx of sortedIndices) {
            const field = mappings[idx];
            let valor = cliente[field] ?? "";

            if (typeof valor === 'string') {
                valor = valor.trim().replace(/,+$/, "");
            } else {
                valor = String(valor);
            }
            
            texto = texto.replace(new RegExp(`{{\\s*${idx}\\s*}}`, "g"), valor);
        }
        
        return texto;
    }

    async sendMessageWithRetry(messagePayload, celularFormatted, attemptNumber = 1) {
        console.log(`📤 [SEND] Attempt ${attemptNumber} for ${celularFormatted}`);
        
        try {
            const response = await fetch(`https://graph.facebook.com/v23.0/${process.env.META_PHONE_NUMBER_ID}/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(messagePayload),
            });

            const responseData = await response.json();
            
            if (response.ok && responseData.messages?.[0]?.id) {
                console.log(`✅ [SUCCESS] Message sent to ${celularFormatted}: ${responseData.messages[0].id}`);
                return { success: true, messageId: responseData.messages[0].id, status: "sent" };
            } else {
                const errorMsg = `Meta API Error (${response.status}): ${responseData.error?.message || 'Unknown error'}`;
                throw new Error(errorMsg);
            }
        } catch (error) {
            console.error(`💥 [CATCH_ERROR] Attempt ${attemptNumber} failed:`, error.message);
            
            if (attemptNumber < config.rateLimit.retryAttempts) {
                await new Promise(resolve => setTimeout(resolve, config.rateLimit.retryDelay));
                return this.sendMessageWithRetry(messagePayload, celularFormatted, attemptNumber + 1);
            }
            
            let estadoError = "failed", codigoError = "UNKNOWN_ERROR";
            if (error.message.includes("Meta API Error")) {
                codigoError = "META_API_ERROR";
                if (error.message.includes("(400)")) estadoError = "rejected";
            } else if (error.message.includes("fetch")) {
                codigoError = "NETWORK_ERROR";
                estadoError = "network_failed";
            }
            
            return { success: false, status: estadoError, errorCode: codigoError, errorMessage: error.message, attemptsMade: attemptNumber };
        }
    }

    async updateMessageStatus(cliente_campanha_id, result, mensajeFinal, cliente, campaignId, template) {
        console.log(`💾 [UPDATE_STATUS] Updating status for cliente_campanha_id: ${cliente_campanha_id}`);
        try {
            if (result.success) {
                await prisma.$transaction(async (tx) => {
                    await tx.cliente_campanha.update({
                        where: { cliente_campanha_id },
                        data: {
                            whatsapp_message_id: result.messageId,
                            estado_mensaje: result.status,
                            fecha_envio: new Date(),
                            fecha_ultimo_estado: new Date(),
                            error_code: null,
                            error_descripcion: null
                        }
                    });
                });
                const firebaseDoc = {
                    celular: cliente.celular,
                    fecha: admin.firestore.Timestamp.fromDate(new Date()),
                    id_bot: "fidelizacionbot",
                    id_cliente: cliente.cliente_id,
                    mensaje: mensajeFinal,
                    template_name: template.nombre_template,
                    sender: "false",
                    message_id: result.messageId,
                    campanha_id: campaignId,
                    estado: result.status
                };
                await db.collection("fidelizacion").doc(cliente.celular).set(firebaseDoc, { merge: true });
            } else {
                await prisma.cliente_campanha.update({
                    where: { cliente_campanha_id },
                    data: {
                        estado_mensaje: result.status,
                        fecha_ultimo_estado: new Date(),
                        error_code: result.errorCode,
                        error_descripcion: result.errorMessage?.substring(0, 255),
                        retry_count: result.attemptsMade
                    }
                });
            }
        } catch (error) {
            console.error(`💥 [UPDATE_CRITICAL] Failed to update status for ${cliente_campanha_id}:`, error.message);
        }
    }
}

// --- API Endpoints ---
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.status(200).json({
    service: 'WhatsApp Campaign Service',
    version: '1.1.0', // Updated version
    status: 'Running'
  });
});

app.post('/send', async (req, res) => {
    console.log("🔥 [START] Received request to send campaign");
    const campaignManager = new WhatsAppCampaignManager();
    let campaignId = null;

    try {
        const idParam = req.body.campaignId || req.query.campaignId;
        campaignId = parseInt(idParam, 10);

        if (isNaN(campaignId)) {
            return res.status(400).json({ error: "Invalid or missing campaignId" });
        }
        console.log(`🔍 [STEP 1] Processing campaignId: ${campaignId}`);

        const campaign = await prisma.campanha.findUnique({
            where: { campanha_id: campaignId },
            include: {
                template: true,
                cliente_campanha: {
                    include: { cliente: true },
                    where: { OR: [{ estado_mensaje: { not: "sent" } }, { estado_mensaje: null }] }
                },
            },
        });

        if (!campaign) {
            return res.status(404).json({ error: `Campaign with ID ${campaignId} not found` });
        }
        if (!campaign.template?.nombre_template) {
            return res.status(400).json({ error: "Campaign is missing a valid template" });
        }
        console.log(`✅ [STEP 2] Found campaign: "${campaign.nombre_campanha}" with ${campaign.cliente_campanha.length} pending clients.`);

        if (campaign.cliente_campanha.length === 0) {
            return res.status(200).json({ message: "No pending clients to send messages to." });
        }

        const mappings = campaign.variable_mappings || {};
        const batches = [];
        for (let i = 0; i < campaign.cliente_campanha.length; i += config.rateLimit.batchSize) {
            batches.push(campaign.cliente_campanha.slice(i, i + config.rateLimit.batchSize));
        }
        console.log(`📦 [PROCESSING] Starting ${batches.length} batches with parallelism of ${config.rateLimit.concurrentBatches}.`);

        const allResults = [];
        for (let i = 0; i < batches.length; i += config.rateLimit.concurrentBatches) {
            const concurrentBatches = batches.slice(i, i + config.rateLimit.concurrentBatches);
            const batchPromises = concurrentBatches.map((batch, index) => 
                processBatch(batch, i + index, campaign, mappings, campaignManager)
            );
            const concurrentResults = await Promise.all(batchPromises);
            allResults.push(...concurrentResults.flat());
            if (i + config.rateLimit.concurrentBatches < batches.length) {
                await new Promise(resolve => setTimeout(resolve, config.rateLimit.pauseBetweenBatches));
            }
        }
        
        const stats = calculateStats(allResults);
        await prisma.campanha.update({
            where: { campanha_id: campaignId },
            data: { estado_campanha: "enviada", fecha_fin: new Date() },
        });

        console.log(`🚀 Campaign ${campaignId} completed. Sent: ${stats.sent}, Failed: ${stats.failed}`);
        res.status(200).json({ success: true, summary: stats, results: allResults });

    } catch (error) {
        console.error("💥 [CRITICAL_ERROR] Unhandled error in /send endpoint:", {
            campaignId,
            error: error.message,
            stack: error.stack
        });
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

async function processBatch(batch, batchIndex, campaign, mappings, campaignManager) {
    console.log(`🚀 Starting batch ${batchIndex + 1}...`);
    const batchPromises = batch.map(async ({ cliente, cliente_campanha_id }) => {
        if (!cliente?.celular) {
            return { success: false, status: "missing_phone", errorMessage: "Client is missing a phone number" };
        }

        let celularRaw = cliente.celular.toString().trim().replace(/[^0-9]/g, '');
        let celularFormatted = celularRaw.startsWith('51') ? celularRaw : `51${celularRaw}`;

        if (!/^519[0-9]{8}$/.test(celularFormatted)) {
             await campaignManager.updateMessageStatus(cliente_campanha_id, { success: false, status: 'invalid_phone', errorCode: 'INVALID_PHONE_FORMAT', errorMessage: `Invalid phone format: ${celularFormatted}` }, '', cliente, campaign.campanha_id, campaign.template);
            return { success: false, status: "invalid_phone", errorMessage: `Invalid phone format: ${celularFormatted}` };
        }

        await campaignManager.waitForRateLimit(campaign.campanha_id);
        const messagePayload = campaignManager.prepareMessagePayload(campaign.template, cliente, mappings, celularFormatted);
        const mensajeFinal = campaignManager.processMessageText(campaign.template, cliente, mappings);
        const result = await campaignManager.sendMessageWithRetry(messagePayload, celularFormatted);
        await campaignManager.updateMessageStatus(cliente_campanha_id, result, mensajeFinal, cliente, campaign.campanha_id, campaign.template);
        return { cliente_id: cliente.cliente_id, ...result };
    });
    return Promise.all(batchPromises);
}

function calculateStats(results) {
    const sent = results.filter(r => r.success).length;
    const failed = results.length - sent;
    return { total: results.length, sent, failed };
}


// --- Server Start and Graceful Shutdown ---
const startServer = async () => {
  try {
    // Verify environment variables before starting
    verifyEnvVariables();

    const server = app.listen(config.port, config.host, () => {
      console.log(`🚀 Server listening on http://${config.host}:${config.port}`);
      console.log('✅ WhatsApp Campaign Service is ready and running.');
      console.log(`🏥 Health check available at http://${config.host}:${config.port}/health`);
    });

    server.timeout = config.serverTimeout;

    const gracefulShutdown = async (signal) => {
      console.log(`🛑 ${signal} received. Shutting down gracefully...`);
      server.close(async () => {
        console.log('🔌 HTTP server closed.');
        await prisma.$disconnect();
        console.log('🗄️ Database connection closed.');
        process.exit(0);
      });
      // Force shutdown after a timeout
      setTimeout(() => {
        console.error('🚨 Could not close connections in time, forcing shutdown.');
        process.exit(1);
      }, 10000); // 10 seconds
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  } catch (error) {
    console.error('💥 Failed to start server:', error);
    process.exit(1);
  }
};

// Handle unhandled promise rejections and exceptions
process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  process.exit(1);
});

// --- Start the application ---
startServer();
