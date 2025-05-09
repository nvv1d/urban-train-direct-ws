# Use Node.js 18 as base image
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./

# Install dev+prod deps so you can compile
RUN npm install

# Copy source files and static assets
COPY tsconfig.json ./
COPY src ./src
COPY public ./public             # ← include your static assets

# Build TypeScript code
RUN npm run build

# Start fresh for the runtime image
FROM node:18-alpine

WORKDIR /app

# Copy built JS files and production node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/public ./public   # ← bring in the public folder
COPY package.json ./

EXPOSE 3000

CMD ["node", "dist/index.js"]
