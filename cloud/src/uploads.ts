// The owner's images sent with a chat message (POST /api/uploads, then POST /api/messages {attachments}).
// Shared by the Worker and the local hub server (src/server.ts) so both accept the same files.

export const MAX_UPLOAD = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
const UPLOAD_TYPES = /^image\/(png|jpeg|gif|webp|heic|heif|bmp)$/;

/** Why the owner's upload is refused (null: it is taken). SVG is refused: it can carry script. */
export function uploadProblem(type: string, size: number): { error: string; status: number } | null {
  if (!UPLOAD_TYPES.test(type)) return { error: "images only (png, jpeg, gif, webp, heic, bmp)", status: 415 };
  if (size > MAX_UPLOAD) return { error: "image too large (10 MB max)", status: 413 };
  if (!size) return { error: "empty file", status: 400 };
  return null;
}

/** A stored upload's id: unique, and safe as a file name and a URL segment. */
export const uploadId = (name: string) =>
  `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${(name || "image").replace(/[^\w.\-]/g, "_").slice(-80)}`;

/** A message's attachments: up to 10 paths of the hub's own media ("/media/<id>"); null when malformed. */
export function ownerAttachments(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_ATTACHMENTS) return null;
  return v.every((x) => typeof x === "string" && /^\/media\/[\w][\w.\-]*$/.test(x) && !x.includes("..")) ? (v as string[]) : null;
}
