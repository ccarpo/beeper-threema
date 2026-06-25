FROM node:22-alpine AS base

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source
COPY tsconfig.json ./
COPY proto/ ./proto/
COPY src/ ./src/

# Runtime
EXPOSE 29318

# Data volumes
VOLUME ["/app/data", "/app/state"]

CMD ["npx", "tsx", "src/main.ts"]
