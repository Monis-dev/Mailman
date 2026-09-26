FROM node:22-alpine

WORKDIR /app

# Install dependencies first (leverages Docker layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Expose API port
EXPOSE 3000

# Default command (overridden by docker-compose)
CMD ["node", "src/api/server.js"]