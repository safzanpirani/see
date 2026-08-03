// Regenerates demo/sample.png — the image the demo tape looks at.
// Deterministic, no network, no fonts beyond the system sans stack.
//   bun run demo/make-sample.ts
import sharp from "sharp";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600">
  <rect width="960" height="600" fill="#ffffff"/>
  <rect x="0" y="0" width="960" height="72" fill="#111318"/>
  <text x="40" y="46" font-family="Helvetica,Arial,sans-serif" font-size="26" font-weight="bold" fill="#ffffff">Quarterly Revenue</text>
  <text x="820" y="46" font-family="Helvetica,Arial,sans-serif" font-size="20" fill="#8b93a1">FY 2026</text>

  <text x="40" y="140" font-family="Helvetica,Arial,sans-serif" font-size="16" fill="#6b7280">TOTAL REVENUE</text>
  <text x="40" y="186" font-family="Helvetica,Arial,sans-serif" font-size="44" font-weight="bold" fill="#111318">$4,271,880</text>

  <text x="400" y="140" font-family="Helvetica,Arial,sans-serif" font-size="16" fill="#6b7280">GROWTH</text>
  <text x="400" y="186" font-family="Helvetica,Arial,sans-serif" font-size="44" font-weight="bold" fill="#16a34a">+18.4%</text>

  <text x="700" y="140" font-family="Helvetica,Arial,sans-serif" font-size="16" fill="#6b7280">CHURN</text>
  <text x="700" y="186" font-family="Helvetica,Arial,sans-serif" font-size="44" font-weight="bold" fill="#dc2626">2.1%</text>

  <line x1="40" y1="230" x2="920" y2="230" stroke="#e5e7eb" stroke-width="2"/>

  <rect x="60"  y="400" width="90" height="120" fill="#111318"/>
  <rect x="200" y="350" width="90" height="170" fill="#111318"/>
  <rect x="340" y="300" width="90" height="220" fill="#111318"/>
  <rect x="480" y="270" width="90" height="250" fill="#111318"/>
  <rect x="620" y="330" width="90" height="190" fill="#9ca3af"/>
  <rect x="760" y="290" width="90" height="230" fill="#9ca3af"/>

  <line x1="40" y1="520" x2="920" y2="520" stroke="#111318" stroke-width="3"/>
  <text x="82"  y="552" font-family="Helvetica,Arial,sans-serif" font-size="20" fill="#374151">Q1</text>
  <text x="222" y="552" font-family="Helvetica,Arial,sans-serif" font-size="20" fill="#374151">Q2</text>
  <text x="362" y="552" font-family="Helvetica,Arial,sans-serif" font-size="20" fill="#374151">Q3</text>
  <text x="502" y="552" font-family="Helvetica,Arial,sans-serif" font-size="20" fill="#374151">Q4</text>
  <text x="636" y="552" font-family="Helvetica,Arial,sans-serif" font-size="20" fill="#9ca3af">Q5*</text>
  <text x="776" y="552" font-family="Helvetica,Arial,sans-serif" font-size="20" fill="#9ca3af">Q6*</text>
  <text x="620" y="582" font-family="Helvetica,Arial,sans-serif" font-size="15" fill="#9ca3af">* forecast</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(new URL("./sample.png", import.meta.url).pathname);
console.log("wrote demo/sample.png");
