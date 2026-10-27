// Cheap checks on a downloaded image BEFORE it is decoded: a few hundred KB can claim to be
// 20000x20000 and would allocate gigabytes on decode. Also the "is this address ours" test
// for the server-side fetch of pasted picture links.
import net from "node:net";

// [width, height] from the header of a PNG, GIF, WebP or JPEG; null for anything else
export function dimensions(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf.length > 10 && buf.toString("latin1", 0, 3) === "GIF") return [buf.readUInt16LE(6), buf.readUInt16LE(8)];
  if (buf.length > 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    const chunk = buf.toString("latin1", 12, 16);
    if (chunk === "VP8 ") return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
    if (chunk === "VP8L") { const b = buf.readUInt32LE(21); return [(b & 0x3fff) + 1, ((b >>> 14) & 0x3fff) + 1]; }
    if (chunk === "VP8X") return [buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1];
    return null;
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) { // JPEG: walk the segments to the frame header
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

// loopback, LAN, link-local, multicast and the v4-in-v6 spellings of them
export function isPrivateAddress(ip) {
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === "::" || l === "::1" || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith("ff");
}
