// MongoDB Atlas connection for SRCTV accounts + sync.
// A single MongoClient is shared process-wide; getDb() awaits the one connect.
// Scraper routes keep working even if Atlas is briefly unreachable — only the
// /auth, /progress and /library handlers await this.
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;

let clientPromise = null;

export function connect() {
  if (!clientPromise) {
    if (!uri) throw new Error("MONGODB_URI is not set");
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 8000,
      maxPoolSize: 10,
    });
    clientPromise = client.connect();
  }
  return clientPromise;
}

export async function getDb() {
  const client = await connect();
  return client.db(); // database name comes from the URI (srctv)
}

export async function col(name) {
  return (await getDb()).collection(name);
}

// Create indexes once at startup. Safe to call repeatedly (idempotent).
export async function ensureIndexes() {
  const db = await getDb();
  await db.collection("users").createIndexes([
    { key: { username: 1 }, unique: true },
    { key: { email: 1 }, unique: true },
  ]);
  await db.collection("watch_progress").createIndexes([
    { key: { userId: 1, mediaType: 1, tmdbId: 1 }, unique: true },
    { key: { userId: 1, updatedAt: -1 } },
  ]);
  await db.collection("library").createIndexes([
    { key: { userId: 1, mediaType: 1, tmdbId: 1 }, unique: true },
    { key: { userId: 1, lastWatchedAt: -1 } },
  ]);
}
