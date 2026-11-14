export interface Cursor {
  timestamp: Date;
  id: number;
}

export function encodeCursor(timestamp: Date, id: number): string {
  const raw = `${timestamp.toISOString()}|${id}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): Cursor | null {
  if (!cursor) return null;
  let decoded;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const idx = decoded.lastIndexOf("|");
  if (idx === -1) return null;
  const ts = decoded.slice(0, idx);
  const idStr = decoded.slice(idx + 1);
  const id = Number(idStr);
  if (!Number.isInteger(id) || id < 0) return null;
  const date = new Date(ts);
  if (isNaN(date.getTime())) return null;
  return { timestamp: date, id };
}
