# Use the official lightweight Node.js 18 image
FROM node:18-slim

# Set the working directory
WORKDIR /usr/src/app

# Install OpenSSL (required for Prisma)
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy the rest of the application code
COPY . .

# Generate Prisma client (if schema.prisma exists)
RUN npx prisma generate || echo "No Prisma schema found, skipping generate"

# Create a non-root user to run the application
RUN useradd -m -u 1001 appuser && chown -R appuser:appuser /usr/src/app
USER appuser

# Expose the port that the app runs on
EXPOSE 8080

# Define environment variable for production
ENV NODE_ENV=production

# Command to run the application
CMD ["npm", "start"]
