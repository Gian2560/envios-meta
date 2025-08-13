const express = require('express');
const { PrismaClient } = require('@prisma/client');
const admin = require('firebase-admin');

// Inicializar Express para Cloud Run
const app = express();

// Middleware básico
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Middleware para CORS
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

// Logging middleware
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path} - ${new Date().toISOString()}`);
  next();
});

// Inicializar Prisma
const prisma = new PrismaClient({
  log: ['error', 'warn'],
});

// Inicializar Firebase Admin si no está inicializado
if (!admin.apps.length) {
  try {
    const serviceAccount = process.env.FIREBASE_CREDENTIALS 
      ? JSON.parse(process.env.FIREBASE_CREDENTIALS)
      : undefined;
    
    admin.initializeApp(serviceAccount ? {
      credential: admin.credential.cert(serviceAccount),
    } : {});
    
    console.log('✅ Firebase Admin inicializado correctamente');
  } catch (error) {
    console.warn("⚠️ Firebase initialization failed:", error.message);
  }
}

const db = admin.firestore();

// Configuración de Meta Business API
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_BUSINESS_ACCOUNT_ID = process.env.META_BUSINESS_ACCOUNT_ID;

// Verificación de variables de entorno al inicio
const requiredEnvVars = {
  META_ACCESS_TOKEN: 'Token de acceso de Meta Business API',
  META_PHONE_NUMBER_ID: 'ID del número de teléfono de WhatsApp',
  DATABASE_URL: 'URL de conexión a la base de datos'
};

console.log('🔍 Verificando variables de entorno requeridas:');
for (const [key, description] of Object.entries(requiredEnvVars)) {
  const value = process.env[key];
  if (value) {
    console.log(`✅ ${key}: CONFIGURADO`);
  } else {
    console.error(`❌ ${key}: FALTANTE - ${description}`);
  }
}

// 🔍 Función de logging estructurado
const logStructured = (level, step, message, data = {}) => {
  const timestamp = new Date().toISOString();
  const logData = {
    timestamp,
    level,
    step,
    message,
    ...data
  };
  
  const icon = {
    'info': 'ℹ️',
    'success': '✅',
    'warning': '⚠️',
    'error': '❌',
    'debug': '🔍'
  }[level] || '📋';
  
  console.log(`${icon} [${step}] ${message}`, Object.keys(data).length > 0 ? data : '');
};

// 🚀 MEJORA 1: Configuración de Rate Limiting OPTIMIZADA
const RATE_LIMIT = {
  messagesPerSecond: 50,
  batchSize: 100,
  retryAttempts: 2,
  retryDelay: 500,
  concurrentBatches: 3,
  pauseBetweenBatches: 100
};

// 🚀 MEJORA 2: Clase para manejo profesional de envíos
class WhatsAppCampaignManager {
  constructor() {
    this.rateLimiter = new Map();
  }

  async waitForRateLimit(campaignId) {
    const now = Date.now();
    const lastSent = this.rateLimiter.get(campaignId) || 0;
    const timeDiff = now - lastSent;
    const minInterval = 1000 / RATE_LIMIT.messagesPerSecond;

    if (timeDiff < minInterval) {
      const waitTime = minInterval - timeDiff;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    this.rateLimiter.set(campaignId, Date.now());
  }

  prepareMessagePayload(template, cliente, mappings, celularFormatted) {
    const bodyParams = [];
    const sortedIndices = Object.keys(mappings).sort((a, b) => parseInt(a) - parseInt(b));
    
    console.log(`🎯 [TEMPLATE_MODE] Usando plantilla de Meta Business: ${template.nombre_template}`);
    console.log(`🗂️ [MAPPINGS] Procesando variables:`, mappings);
    
    for (const idx of sortedIndices) {
      const field = mappings[idx];
      let valor = cliente[field] ?? "";
      
      if (field === 'monto' && valor) {
        valor = String(valor).replace(/,+$/, "");
      } else if (field === 'feccuota' && valor) {
        valor = String(valor).trim();
      } else {
        valor = String(valor).trim().replace(/,+$/, "");
      }
      
      console.log(`📝 [PARAM_${idx}] ${field}: "${valor}"`);
      
      bodyParams.push({
        type: "text",
        text: valor
      });
    }
    
    const payload = {
      messaging_product: "whatsapp",
      to: celularFormatted,
      type: "template",
      template: {
        name: template.nombre_template,
        language: { code: "es_PE"},
        components: bodyParams.length > 0 ? [{
          type: "body",
          parameters: bodyParams
        }] : []
      }
    };
    
    console.log(`📦 [TEMPLATE_PAYLOAD] Payload final:`, JSON.stringify(payload, null, 2));
    return payload;
  }

  processMessageText(template, cliente, mappings) {
    const sortedIndices = Object.keys(mappings).sort((a, b) => parseInt(a) - parseInt(b));
    let texto = template.mensaje || `Template: ${template.nombre_template}`;
    
    console.log(`📄 [MESSAGE_PROCESSING] Procesando mensaje para referencia: "${texto.substring(0, 50)}..."`);
    
    for (const idx of sortedIndices) {
      const field = mappings[idx];
      let valor = cliente[field] ?? "";
      
      if (field === 'monto' && valor) {
        valor = String(valor).replace(/,+$/, "");
      } else if (field === 'feccuota' && valor) {
        valor = String(valor).trim();
      } else {
        valor = String(valor).trim().replace(/,+$/, "");
      }
      
      texto = texto.replace(new RegExp(`{{\\s*${idx}\\s*}}`, "g"), valor);
    }
    
    console.log(`📝 [MESSAGE_FINAL] Mensaje procesado para referencia: "${texto.substring(0, 100)}..."`);
    return texto;
  }

  async sendMessageWithRetry(messagePayload, celularFormatted, attemptNumber = 1) {
    console.log(`📤 [SEND] Intento ${attemptNumber} para ${celularFormatted}`);
    console.log(`📋 [PAYLOAD] Payload:`, JSON.stringify(messagePayload, null, 2));
    
    try {
      console.log(`🌐 [API] Enviando request a Meta Business API`);
      const response = await fetch(`https://graph.facebook.com/v23.0/${META_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messagePayload),
      });

      console.log(`📈 [RESPONSE] Status: ${response.status}, OK: ${response.ok}`);
      const responseData = await response.json();
      console.log(`📄 [RESPONSE_DATA]`, responseData);
      
      if (responseData.messages && responseData.messages.length > 0) {
        const message = responseData.messages[0];
        console.log(`🆔 [MESSAGE_ID] ID del mensaje: ${message.id}`);
        console.log(`📱 [WHATSAPP_ID] WhatsApp ID del destinatario: ${responseData.contacts?.[0]?.wa_id}`);
        console.log(`📞 [INPUT_NUMBER] Número de entrada: ${responseData.contacts?.[0]?.input}`);
        
        if (message.message_status) {
          console.log(`📊 [MESSAGE_STATUS] Estado del mensaje: ${message.message_status}`);
        }
      }

      if (response.ok && responseData.messages && responseData.messages.length > 0) {
        console.log(`✅ [SUCCESS] Mensaje enviado a ${celularFormatted}: ${responseData.messages[0].id}`);
        return {
          success: true,
          messageId: responseData.messages[0].id,
          status: "sent"
        };
      } else {
        const errorMsg = `Meta API Error (${response.status}): ${responseData.error?.message || 'Unknown error'}`;
        console.error(`❌ [API_ERROR] ${errorMsg}`);
        throw new Error(errorMsg);
      }
    } catch (error) {
      console.error(`💥 [CATCH_ERROR] Intento ${attemptNumber} falló:`, error.message);
      
      if (attemptNumber < RATE_LIMIT.retryAttempts) {
        console.log(`🔄 [RETRY] Esperando ${RATE_LIMIT.retryDelay}ms antes del siguiente intento...`);
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT.retryDelay));
        return this.sendMessageWithRetry(messagePayload, celularFormatted, attemptNumber + 1);
      }
      
      let estadoError = "failed";
      let codigoError = "UNKNOWN_ERROR";
      
      if (error.message.includes("Meta API Error")) {
        codigoError = "META_API_ERROR";
        if (error.message.includes("(400)")) estadoError = "rejected";
        else if (error.message.includes("(401)") || error.message.includes("(403)")) estadoError = "unauthorized";
        else if (error.message.includes("(429)")) estadoError = "rate_limited";
        else if (error.message.includes("(500)") || error.message.includes("(503)")) estadoError = "server_error";
      } else if (error.message.includes("timeout") || error.message.includes("fetch")) {
        codigoError = "NETWORK_ERROR";
        estadoError = "network_failed";
      }
      
      console.error(`🏷️ [ERROR_CLASSIFIED] Estado: ${estadoError}, Código: ${codigoError}`);
      
      return {
        success: false,
        status: estadoError,
        errorCode: codigoError,
        errorMessage: error.message,
        attemptsMade: attemptNumber
      };
    }
  }

  async updateMessageStatus(cliente_campanha_id, result, mensajeFinal, cliente, campaignId, template) {
    console.log(`💾 [UPDATE_START] Actualizando estado para cliente_campanha_id: ${cliente_campanha_id}`);
    console.log(`📊 [UPDATE_DATA] Result:`, result);
    
    try {
      if (result.success) {
        console.log(`✅ [UPDATE_SUCCESS] Procesando mensaje exitoso`);
        
        await prisma.$transaction(async (tx) => {
          console.log(`🔄 [TRANSACTION] Iniciando transacción de BD`);
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
          console.log(`✅ [TRANSACTION] BD actualizada correctamente`);
        });

        console.log(`🔥 [FIREBASE] Guardando mensaje en Firestore`);
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
        console.log(`✅ [FIREBASE] Mensaje guardado en Firestore`);
        
      } else {
        console.log(`❌ [UPDATE_ERROR] Procesando mensaje fallido`);
        
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
        console.log(`❌ [BD_ERROR] Error registrado en BD`);
      }
    } catch (error) {
      console.error(`💥 [UPDATE_CRITICAL] Error actualizando estado para cliente_campanha ${cliente_campanha_id}:`, {
        error: error.message,
        cliente_campanha_id,
        result
      });
    }
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'WhatsApp Campaign Service'
  });
});

// Root endpoint para información del servicio
app.get('/', (req, res) => {
  res.status(200).json({
    service: 'WhatsApp Campaign Service',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      sendCampaign: 'POST /send'
    },
    timestamp: new Date().toISOString()
  });
});

// Endpoint principal para envío de campañas
app.post('/send', async (req, res) => {
  console.log("🔥 [START] Iniciando Google Cloud Run Service para envío de campaña");
  
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido. Usar POST.' });
    return;
  }

  const campaignManager = new WhatsAppCampaignManager();
  let campaignId = null;
  
  try {
    console.log("📝 [STEP 1] Extrayendo parámetros de la request");
    
    const { campaignId: bodyId } = req.body || {};
    const { campaignId: queryId } = req.query || {};
    const pathId = req.path.match(/\/(\d+)$/)?.[1];
    
    const idParam = bodyId || queryId || pathId;
    campaignId = parseInt(idParam, 10);
    
    console.log(`📋 [PARAMS] ID recibido: ${idParam}, ID parseado: ${campaignId}`);
    console.log(`📋 [REQUEST] Body:`, req.body);
    console.log(`📋 [REQUEST] Query:`, req.query);
    console.log(`📋 [REQUEST] Path:`, req.path);
    
    if (isNaN(campaignId)) {
      console.error("❌ [ERROR] ID de campaña no válido:", idParam);
      res.status(400).json({ error: "ID de campaña no válido" });
      return;
    }

    console.log("🔍 [STEP 2] Buscando campaña en base de datos");
    const campaign = await prisma.campanha.findUnique({
      where: { campanha_id: campaignId },
      include: {
        template: true,
        cliente_campanha: { 
          include: { cliente: true },
          where: {
            OR: [
                { estado_mensaje: { not: "sent" } },
                { estado_mensaje: null }
              ]
          }
        },
      },
    });

    console.log(`📊 [QUERY] Campaña encontrada: ${campaign ? 'SÍ' : 'NO'}`);
    if (campaign) {
      console.log(`📋 [CAMPAIGN] ID: ${campaign.campanha_id}, Nombre: ${campaign.nombre_campanha}`);
      console.log(`📋 [TEMPLATE] ID: ${campaign.template?.template_id}, Nombre: ${campaign.template?.nombre_template}`);
      console.log(`👥 [CLIENTS] Clientes a procesar: ${campaign.cliente_campanha?.length || 0}`);
    }

    if (!campaign) {
      console.error("❌ [ERROR] Campaña no encontrada con ID:", campaignId);
      res.status(404).json({ error: "Campaña no encontrada" });
      return;
    }

    if (!campaign.template?.nombre_template) {
      console.error("❌ [ERROR] Template inválido:", campaign.template);
      res.status(400).json({ error: "Template inválido" });
      return;
    }

    // Verificar variables de entorno
    console.log("🔐 [ENV] Verificando variables de entorno:");
    console.log(`📞 META_PHONE_NUMBER_ID: ${META_PHONE_NUMBER_ID ? 'CONFIGURADO' : 'FALTANTE'}`);
    console.log(`🔑 META_ACCESS_TOKEN: ${META_ACCESS_TOKEN ? 'CONFIGURADO' : 'FALTANTE'}`);
    console.log(`🏢 META_BUSINESS_ACCOUNT_ID: ${META_BUSINESS_ACCOUNT_ID ? 'CONFIGURADO' : 'FALTANTE'}`);

    if (!META_ACCESS_TOKEN || !META_PHONE_NUMBER_ID) {
      console.error("❌ [ERROR] Variables de entorno de Meta Business API faltantes");
      res.status(500).json({ error: "Configuración de Meta Business API incompleta" });
      return;
    }

    console.log("✅ [VALIDATION] Validaciones básicas completadas");

    const logger = {
      campaign: campaignId,
      template: campaign.template.nombre_template,
      totalClients: campaign.cliente_campanha.length,
      timestamp: new Date().toISOString()
    };

    console.log(`🎯 [${logger.timestamp}] Iniciando campaña ${campaignId}:`, logger);
    console.log(`📋 [MAPPINGS] Variable mappings:`, campaign.variable_mappings);

    const mappings = campaign.variable_mappings || {};

    if (campaign.cliente_campanha.length === 0) {
      console.warn("⚠️ [WARNING] No hay clientes pendientes de envío");
      res.status(200).json({ 
        success: true,
        message: "No hay clientes pendientes de envío",
        summary: {
          total: 0,
          sent: 0,
          failed: 0,
          campaignId
        }
      });
      return;
    }

    // Procesamiento por lotes
    const batches = [];
    for (let i = 0; i < campaign.cliente_campanha.length; i += RATE_LIMIT.batchSize) {
      batches.push(campaign.cliente_campanha.slice(i, i + RATE_LIMIT.batchSize));
    }

    console.log(`📦 Procesando ${batches.length} lotes de hasta ${RATE_LIMIT.batchSize} clientes cada uno`);
    console.log(`⚡ Configuración optimizada: ${RATE_LIMIT.messagesPerSecond} msg/seg, ${RATE_LIMIT.concurrentBatches} lotes paralelos`);

    const processBatch = async (batch, batchIndex) => {
      console.log(`🚀 Iniciando lote ${batchIndex + 1}/${batches.length} (${batch.length} clientes)`);
      const startTime = Date.now();

      const batchPromises = batch.map(async ({ cliente, cliente_campanha_id }) => {
        if (!cliente?.celular) {
          console.warn(`⚠ Cliente ${cliente?.nombre || "Desconocido"} sin número válido`);
          return null;
        }

        // Formatear número correctamente
        let celularRaw = cliente.celular.toString().trim();
        console.log(`📞 [PHONE_RAW] Número original: "${celularRaw}"`);
        
        celularRaw = celularRaw.replace(/[^0-9+]/g, '').replace(/^\+/, '');
        console.log(`📞 [PHONE_CLEAN] Número limpio: "${celularRaw}"`);
        
        let celularFormatted;
        
        if (celularRaw.startsWith('51') && celularRaw.length === 11) {
          celularFormatted = celularRaw;
          console.log(`📞 [PHONE_LOGIC] Ya tiene código 51: ${celularFormatted}`);
        } else if (celularRaw.startsWith('9') && celularRaw.length === 9) {
          celularFormatted = `51${celularRaw}`;
          console.log(`📞 [PHONE_LOGIC] Agregando 51 a número de 9 dígitos: ${celularFormatted}`);
        } else if (celularRaw.length >= 8 && celularRaw.length <= 9 && /^[0-9]+$/.test(celularRaw)) {
          celularFormatted = `51${celularRaw}`;
          console.log(`📞 [PHONE_LOGIC] Agregando 51 a número válido: ${celularFormatted}`);
        } else {
          console.error(`❌ [PHONE_ERROR] Número inválido: "${celularRaw}"`);
          return {
            cliente_campanha_id,
            celular: celularRaw,
            cliente_id: cliente.cliente_id,
            success: false,
            status: "invalid_phone",
            errorCode: "INVALID_PHONE_FORMAT",
            errorMessage: `Número de teléfono inválido: ${celularRaw}`,
            attemptsMade: 0
          };
        }
        
        if (!/^51[0-9]{9}$/.test(celularFormatted)) {
          console.error(`❌ [PHONE_VALIDATION] Formato final inválido: "${celularFormatted}"`);
          return {
            cliente_campanha_id,
            celular: celularFormatted,
            cliente_id: cliente.cliente_id,
            success: false,
            status: "invalid_phone",  
            errorCode: "INVALID_WHATSAPP_FORMAT",
            errorMessage: `Formato de WhatsApp inválido: ${celularFormatted}`,
            attemptsMade: 0
          };
        }
        
        console.log(`📞 [PHONE_FINAL] Número formateado final: "${celularFormatted}"`);

        await campaignManager.waitForRateLimit(campaignId);

        console.log(`🎯 [MESSAGE_PREP] Preparando mensaje usando plantilla de Meta Business API`);
        console.log(`📋 [TEMPLATE_INFO] Nombre: ${campaign.template.nombre_template}, Parámetros: ${Object.keys(mappings).length}`);
        
        const messagePayload = campaignManager.prepareMessagePayload(
          campaign.template, cliente, mappings, celularFormatted
        );
        const mensajeFinal = campaignManager.processMessageText(
          campaign.template, cliente, mappings
        );
        
        console.log(`🚀 [SEND_TYPE] Enviando como TEMPLATE (no texto libre) para permitir mensajes a clientes nuevos`);

        const result = await campaignManager.sendMessageWithRetry(messagePayload, celularFormatted);

        await campaignManager.updateMessageStatus(
          cliente_campanha_id, result, mensajeFinal, cliente, campaignId, campaign.template
        );

        return {
          cliente_campanha_id,
          celular: celularFormatted,
          cliente_id: cliente.cliente_id,
          ...result
        };
      });

      const batchResults = await Promise.all(batchPromises);
      const processingTime = (Date.now() - startTime) / 1000;
      const successfulInBatch = batchResults.filter(r => r?.success).length;
      
      console.log(`✅ Lote ${batchIndex + 1} completado en ${processingTime.toFixed(2)}s - Exitosos: ${successfulInBatch}/${batch.length}`);
      
      return batchResults.filter(r => r !== null);
    };

    // Procesar lotes con paralelismo controlado
    const allResults = [];
    for (let i = 0; i < batches.length; i += RATE_LIMIT.concurrentBatches) {
      const concurrentBatches = batches.slice(i, i + RATE_LIMIT.concurrentBatches);
      
      const concurrentPromises = concurrentBatches.map((batch, index) => 
        processBatch(batch, i + index)
      );

      const concurrentResults = await Promise.all(concurrentPromises);
      allResults.push(...concurrentResults.flat());

      if (i + RATE_LIMIT.concurrentBatches < batches.length) {
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT.pauseBetweenBatches));
      }

      const processed = Math.min(i + RATE_LIMIT.concurrentBatches, batches.length);
      const progressPercent = ((processed / batches.length) * 100).toFixed(1);
      console.log(`📊 Progreso: ${processed}/${batches.length} lotes (${progressPercent}%)`);
    }

    const results = allResults;

    const totalProcessingTime = Date.now() - new Date(logger.timestamp).getTime();
    const stats = {
      total: results.length,
      sent: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      errorBreakdown: results
        .filter(r => !r.success)
        .reduce((acc, r) => {
          acc[r.status] = (acc[r.status] || 0) + 1;
          return acc;
        }, {}),
      performance: {
        totalTimeMs: totalProcessingTime,
        totalTimeMinutes: (totalProcessingTime / 60000).toFixed(2),
        messagesPerSecond: (results.length / (totalProcessingTime / 1000)).toFixed(2),
        successRate: ((results.filter(r => r.success).length / results.length) * 100).toFixed(1)
      }
    };

    await prisma.campanha.update({
      where: { campanha_id: campaignId },
      data: { 
        estado_campanha: "enviada",
        fecha_fin: new Date(),
      },
    });

    console.log(`🚀 Campaña ${campaignId} completada en ${stats.performance.totalTimeMinutes} minutos:`, stats);
    console.log(`⚡ Rendimiento: ${stats.performance.messagesPerSecond} msg/seg - Éxito: ${stats.performance.successRate}%`);

    res.status(200).json({ 
      success: true, 
      results,
      summary: {
        ...stats,
        campaignId,
        batchesProcessed: batches.length,
        configuration: {
          messagesPerSecond: RATE_LIMIT.messagesPerSecond,
          batchSize: RATE_LIMIT.batchSize,
          concurrentBatches: RATE_LIMIT.concurrentBatches
        }
      }
    });

  } catch (error) {
    console.error("💥 [CRITICAL_ERROR] Error crítico en Google Cloud Run:", {
      campaignId,
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    
    res.status(500).json({ 
      error: "Error interno del servidor",
      errorDetails: error.message,
      campaignId: campaignId,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  } finally {
    // Cerrar conexión de Prisma al finalizar
    await prisma.$disconnect();
  }
});

// Iniciar el servidor en el puerto especificado por Cloud Run
const port = process.env.PORT || 8080;

// Inicializar servidor
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 WhatsApp Campaign Service running on port ${port}`);
  console.log(`🏥 Health check available at /health`);
  console.log(`📱 Campaign endpoint available at POST /send`);
  console.log(`ℹ️  Service info available at GET /`);
  console.log(`🌍 Server listening on 0.0.0.0:${port}`);
});

// Timeout para el servidor
server.timeout = 900000; // 15 minutos

// Error handler para el servidor
server.on('error', (error) => {
  console.error('❌ Server error:', error);
  process.exit(1);
});

// Manejo de cierre graceful
const gracefulShutdown = async (signal) => {
  console.log(`🛑 ${signal} received, shutting down gracefully...`);
  
  server.close(async () => {
    console.log('🔌 HTTP server closed');
    
    try {
      await prisma.$disconnect();
      console.log('🗄️ Database connection closed');
    } catch (error) {
      console.error('❌ Error closing database:', error);
    }
    
    process.exit(0);
  });
  
  // Forzar cierre después de 10 segundos
  setTimeout(() => {
    console.error('🚨 Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Manejo de errores no capturados
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

console.log('🚀 WhatsApp Campaign Service initialized successfully');
