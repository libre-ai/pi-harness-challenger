const JSON_MEDIA_TYPE_PATTERN = /^application\/(?:json|[0-9A-Za-z!#$&^_.+-]+\+json)$/i;

export async function readBoundedJsonResponse(response, { maxBytes = 128 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("release-descriptor-limit-invalid");
  const mediaType = response?.headers?.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
  if (!JSON_MEDIA_TYPE_PATTERN.test(mediaType)) throw new Error("release-descriptor-media-type-invalid");
  if (response.body === null) throw new Error("release-descriptor-body-missing");

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
      await response.body.cancel();
      throw new Error("release-descriptor-content-length-invalid");
    }
    if (Number(declaredLength) > maxBytes) {
      await response.body.cancel();
      throw new Error("release-descriptor-too-large");
    }
  }

  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("release-descriptor-body-invalid");
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel();
        throw new Error("release-descriptor-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("release-descriptor-utf8-invalid");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("release-descriptor-json-invalid");
  }
}
