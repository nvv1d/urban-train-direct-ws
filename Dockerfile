
# Use Node.js 18 as base image
FROM node:18-alpine AS builder

# Create app directory
WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./

# Install only production dependencies for the final image
RUN npm install --only=production

# Install all dependencies for building
RUN npm install

# Copy source files
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript code
RUN npm run build

# Start fresh for the runtime image
FROM node:18-alpine

WORKDIR /app

# Copy built JS files and production node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Expose the port the app runs on
EXPOSE 3000

# Command to run the application
CMD ["node", "dist/index.js"]
