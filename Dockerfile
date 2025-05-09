# Use Node.js 18 as base image for building
FROM node:18-alpine AS builder
WORKDIR /app

# Copy package manifests and install all deps (needed to build + production)
COPY package*.json ./
RUN npm install

# Copy your source and static assets
COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# Build the TypeScript
RUN npm run build

# ------ runtime image ------
FROM node:18-alpine
WORKDIR /app

# Copy built code, node_modules and static assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/public ./public
COPY package.json ./

# Expose the port
EXPOSE 3000

# Start the application
CMD ["node", "dist/index.js"]
