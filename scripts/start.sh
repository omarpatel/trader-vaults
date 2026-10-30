#!/bin/bash
# Railway deployment helper script

echo "Starting Railway deployment..."

# Install dependencies
echo "Installing dependencies..."
npm install

# Generate Prisma client
echo "Generating Prisma client..."
cd apps/api && npx prisma generate && cd ../..

# Build the project
echo "Building project..."
npm run build

# Start the API server
echo "Starting API server..."
node --import tsx apps/api/src/index.ts