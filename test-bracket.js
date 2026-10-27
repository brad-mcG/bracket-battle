// Self-check for the bracket logic: node test-bracket.js
import assert from "node:assert/strict";
import { buildBracket, nextMatch, setWinner, champion, roundName, youtubeId } from "./src/bracket.js";
import { layoutBracket } from "./src/layout.js";
import { dimensions, isPrivateAddress } from "./src/imagecheck.js";

for (let n = 2; n <= 70; n++) {
  for (let trial = 0; trial < 20; trial++) {
    const rounds = buildBracket(n);
    const seen = rounds[0].flatMap((mt) => [mt.a, mt.b]).filter((x) => x !== null);
    assert.deepEqual(seen.sort((x, y) => x - y), [...Array(n).keys()], `every entry placed once (n=${n})`);
    let played = 0, next;
    while ((next = nextMatch(rounds))) {
      const mt = rounds[next.r][next.m];
      setWinner(rounds, next.r, next.m, Math.random() < 0.5 ? mt.a : mt.b);
      played++;
    }
    assert.equal(played, n - 1, `n-1 real matchups, byes never voted on (n=${n})`);
    assert.notEqual(champion(rounds), null, `champion decided (n=${n})`);
  }
}

assert.equal(roundName(buildBracket(16), 0), "Round of 16");
assert.equal(roundName(buildBracket(16), 3), "Final");
assert.equal(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10"), "dQw4w9WgXcQ");
assert.equal(youtubeId("https://youtu.be/dQw4w9WgXcQ?si=abc"), "dQw4w9WgXcQ");
assert.equal(youtubeId("https://music.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(youtubeId("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(youtubeId("Hey Jude"), null);

// picture layout: every slot inside the canvas, no two slots overlapping, one slot per entry
// still in each round, champion present
for (const n of [2, 3, 4, 5, 8, 13, 32, 37, 64, 128, 200, 256]) {
  const rounds = buildBracket(n);
  let next;
  while ((next = nextMatch(rounds))) { const mt = rounds[next.r][next.m]; setWinner(rounds, next.r, next.m, mt.a); }
  const L = layoutBracket(rounds);
  const { slotW: SLOT_W, slotH: SLOT_H } = L;
  assert.ok(L.height < 13000, `picture height sane (n=${n}: ${L.height})`);
  assert.notEqual(L.champion, null, `champion in layout (n=${n})`);
  for (const s of L.slots) assert.ok(s.x >= 0 && s.y >= 0 && s.x + SLOT_W <= L.width && s.y + SLOT_H <= L.height, `slot inside canvas (n=${n})`);
  const overlap = (p, q) => p !== q && Math.abs(p.x - q.x) < SLOT_W && Math.abs(p.y - q.y) < SLOT_H;
  assert.ok(!L.slots.some((p) => L.slots.some((q) => overlap(p, q))), `no overlapping slots (n=${n})`);
  const size = 2 ** rounds.length;
  assert.equal(L.slots.length, 2 * size - 2, `one slot per entry per round (n=${n})`);
}

// image header sniffing (sizes read without decoding) and private-address detection
const png = Buffer.alloc(33); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(12000, 16); png.writeUInt32BE(9000, 20);
assert.deepEqual(dimensions(png), [12000, 9000]);
const gif = Buffer.from("GIF89a\x40\x01\xf0\x00\x00\x00\x00", "latin1");
assert.deepEqual(dimensions(gif), [320, 240]);
const jpg = Buffer.from("ffd8" + "ffe000104a46494600010100000100010000" + "ffc0000b08" + "0100" + "0180" + "03", "hex");
assert.deepEqual(dimensions(jpg), [384, 256]);
const webp = Buffer.alloc(32); webp.write("RIFF", 0, "latin1"); webp.write("WEBP", 8, "latin1"); webp.write("VP8X", 12, "latin1"); webp.writeUIntLE(1343, 24, 3); webp.writeUIntLE(755, 27, 3);
assert.deepEqual(dimensions(webp), [1344, 756]);
assert.equal(dimensions(Buffer.from("<html>not an image at all</html>")), null);
for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.10", "169.254.169.254", "0.0.0.0", "::1", "fe80::1", "fd00::5", "::ffff:192.168.1.1", "224.0.0.1"]) assert.ok(isPrivateAddress(ip), `${ip} is private`);
for (const ip of ["8.8.8.8", "68.117.151.145", "2606:4700::1111", "172.32.0.1", "::ffff:1.2.3.4"]) assert.ok(!isPrivateAddress(ip), `${ip} is public`);
console.log("bracket ok");
