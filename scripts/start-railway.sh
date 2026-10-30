#!/bin/bash
echo "Starting Trader Vaults API..."
echo "Environment: $NODE_ENV"
echo "Working directory: $(pwd)"
echo "Node version: $(node --version)"

# Try starting the API
cd apps/api
if [ -f "dist/index.js" ]; then
  echo "Starting from compiled JS..."
  node dist/index.js
else
  echo "Starting from TSX..."
  npx tsx src/index.ts
fi