#!/bin/bash
set -e

echo "1. Stopping and removing any existing container..."
docker rm -f cascade_pgvector 2>/dev/null || true
docker volume rm cascade_pg_data 2>/dev/null || true

echo "2. Starting fresh PostgreSQL with pgvector..."
docker run -d \
  --name cascade_pgvector \
  -e POSTGRES_USER=cascade \
  -e POSTGRES_PASSWORD=cascade_dev_password \
  -e POSTGRES_DB=cascade \
  -p 5432:5432 \
  -v cascade_pg_data:/var/lib/postgresql/data \
  pgvector/pgvector:pg16

echo "3. Waiting for database to be ready..."
until docker exec cascade_pgvector pg_isready -U cascade >/dev/null 2>&1; do
  sleep 1
done
echo "   Database is ready!"

echo "4. Enabling pgvector extension..."
docker exec cascade_pgvector psql -U cascade -d cascade -c "CREATE EXTENSION IF NOT EXISTS vector;"

echo "5. Emitting Prisma contract..."
bunx prisma contract emit

echo "6. Initializing database schema..."
export DATABASE_URL="postgres://cascade:cascade_dev_password@localhost:5432/cascade"
bunx prisma db init

echo "7. Adding native vector column..."
docker exec cascade_pgvector psql -U cascade -d cascade -c "ALTER TABLE intent_embeddings ADD COLUMN IF NOT EXISTS embedding_vector vector(768);"

echo "8. Creating HNSW index for cosine similarity..."
docker exec cascade_pgvector psql -U cascade -d cascade -c "CREATE INDEX IF NOT EXISTS embedding_vector_hnsw_idx ON intent_embeddings USING hnsw (embedding_vector vector_cosine_ops);"

echo ""
echo "   Connection: postgres://cascade:cascade_dev_password@localhost:5432/cascade"
echo "   Container:  cascade_pgvector"
echo ""
echo "To stop:    docker stop cascade_pgvector"
echo "To start:   docker start cascade_pgvector"
echo "To reset:   bash setup-db.sh"
