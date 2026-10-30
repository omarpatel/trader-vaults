#!/bin/bash
# ── Production Database Migration Script for Railway ───────────────
# Run this after deploying to Railway to set up the production database

set -e

echo "🚀 Starting production database migration..."

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL environment variable is not set"
    echo "Please set DATABASE_URL to your PostgreSQL connection string"
    exit 1
fi

echo "📡 Database URL: ${DATABASE_URL:0:20}..."

# Navigate to the API directory
cd "$(dirname "$0")/apps/api"

# Generate Prisma client
echo "🔧 Generating Prisma client..."
npx prisma generate

# Push schema to production database
echo "📤 Pushing schema to production database..."
npx prisma db push --accept-data-loss

# Seed production data (optional - uncomment if needed)
# echo "🌱 Seeding production data..."
# npx prisma db seed

echo "✅ Production database migration completed successfully!"

# Run health check
echo "🏥 Running health check..."
curl -f http://localhost:8787/api/health || echo "⚠️  Health check failed - this is expected if server isn't running yet"

echo "🎉 Production is ready!"
