import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DIAGRAMS = [
  { name: 'Tenancy Model', file: '_tenancy-model.html' },
  { name: 'OpenShift Deployment', file: '_openshift-deployment.html' },
];

for (const diagram of DIAGRAMS) {
  const diagramPath = path.resolve(__dirname, '../docs', diagram.file);

  test.describe(`${diagram.name} Diagram - overlap validation`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`file://${diagramPath}`);
      await page.waitForSelector('svg');
    });

    test('no text elements overlap with lines', async ({ page }) => {
      const overlaps = await page.evaluate(() => {
        const svg = document.querySelector('svg')!;
        const texts = Array.from(svg.querySelectorAll('text'));
        const lines = Array.from(svg.querySelectorAll('line'));
        const issues: string[] = [];

        // Get bounding box for each text element
        for (const text of texts) {
          const textContent = text.textContent?.trim() || '';
          if (!textContent || textContent === '') continue;

          const textBox = (text as SVGTextElement).getBBox();
          // Add small padding
          const tLeft = textBox.x - 2;
          const tRight = textBox.x + textBox.width + 2;
          const tTop = textBox.y - 2;
          const tBottom = textBox.y + textBox.height + 2;

          // Check against lines
          for (const line of lines) {
            const x1 = parseFloat(line.getAttribute('x1') || '0');
            const y1 = parseFloat(line.getAttribute('y1') || '0');
            const x2 = parseFloat(line.getAttribute('x2') || '0');
            const y2 = parseFloat(line.getAttribute('y2') || '0');

            // Check if line segment intersects text bounding box
            if (lineIntersectsRect(x1, y1, x2, y2, tLeft, tTop, tRight, tBottom)) {
              issues.push(
                `LINE overlaps TEXT "${textContent.substring(0, 40)}": ` +
                  `line(${x1},${y1} → ${x2},${y2}) ∩ text(${Math.round(tLeft)},${Math.round(tTop)},${Math.round(tRight)},${Math.round(tBottom)})`
              );
            }
          }
        }

        // Helper: check if line segment intersects rectangle
        function lineIntersectsRect(
          x1: number,
          y1: number,
          x2: number,
          y2: number,
          left: number,
          top: number,
          right: number,
          bottom: number
        ): boolean {
          // Check if either endpoint is inside the rect
          if (pointInRect(x1, y1, left, top, right, bottom)) return true;
          if (pointInRect(x2, y2, left, top, right, bottom)) return true;

          // Check if line crosses any edge of rect
          if (lineSegmentsIntersect(x1, y1, x2, y2, left, top, right, top)) return true;
          if (lineSegmentsIntersect(x1, y1, x2, y2, right, top, right, bottom)) return true;
          if (lineSegmentsIntersect(x1, y1, x2, y2, left, bottom, right, bottom)) return true;
          if (lineSegmentsIntersect(x1, y1, x2, y2, left, top, left, bottom)) return true;

          return false;
        }

        function pointInRect(
          px: number,
          py: number,
          l: number,
          t: number,
          r: number,
          b: number
        ): boolean {
          return px >= l && px <= r && py >= t && py <= b;
        }

        function lineSegmentsIntersect(
          ax1: number,
          ay1: number,
          ax2: number,
          ay2: number,
          bx1: number,
          by1: number,
          bx2: number,
          by2: number
        ): boolean {
          const d1 = direction(bx1, by1, bx2, by2, ax1, ay1);
          const d2 = direction(bx1, by1, bx2, by2, ax2, ay2);
          const d3 = direction(ax1, ay1, ax2, ay2, bx1, by1);
          const d4 = direction(ax1, ay1, ax2, ay2, bx2, by2);

          if (
            ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
            ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
          ) {
            return true;
          }

          if (d1 === 0 && onSegment(bx1, by1, bx2, by2, ax1, ay1)) return true;
          if (d2 === 0 && onSegment(bx1, by1, bx2, by2, ax2, ay2)) return true;
          if (d3 === 0 && onSegment(ax1, ay1, ax2, ay2, bx1, by1)) return true;
          if (d4 === 0 && onSegment(ax1, ay1, ax2, ay2, bx2, by2)) return true;

          return false;
        }

        function direction(
          ax: number,
          ay: number,
          bx: number,
          by: number,
          cx: number,
          cy: number
        ): number {
          return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        }

        function onSegment(
          ax: number,
          ay: number,
          bx: number,
          by: number,
          cx: number,
          cy: number
        ): boolean {
          return (
            Math.min(ax, bx) <= cx &&
            cx <= Math.max(ax, bx) &&
            Math.min(ay, by) <= cy &&
            cy <= Math.max(ay, by)
          );
        }

        return issues;
      });

      if (overlaps.length > 0) {
        console.log('OVERLAPS FOUND:');
        for (const o of overlaps) console.log(`  - ${o}`);
      }
      expect(
        overlaps,
        `Found ${overlaps.length} line/text overlaps:\n${overlaps.join('\n')}`
      ).toHaveLength(0);
    });

    test('no text elements overlap with other text elements', async ({ page }) => {
      const overlaps = await page.evaluate(() => {
        const svg = document.querySelector('svg')!;
        const texts = Array.from(svg.querySelectorAll('text'));
        const issues: string[] = [];

        const boxes = texts
          .map((t) => ({
            content: t.textContent?.trim() || '',
            box: (t as SVGTextElement).getBBox(),
          }))
          .filter((b) => b.content.length > 0);

        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i].box;
            const b = boxes[j].box;

            // Check rectangle overlap with 1px tolerance
            const overlap =
              a.x < b.x + b.width - 1 &&
              a.x + a.width > b.x + 1 &&
              a.y < b.y + b.height - 1 &&
              a.y + a.height > b.y + 1;

            if (overlap) {
              issues.push(
                `TEXT "${boxes[i].content.substring(0, 30)}" overlaps TEXT "${boxes[j].content.substring(0, 30)}": ` +
                  `(${Math.round(a.x)},${Math.round(a.y)},${Math.round(a.width)}x${Math.round(a.height)}) ∩ ` +
                  `(${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)}x${Math.round(b.height)})`
              );
            }
          }
        }

        return issues;
      });

      if (overlaps.length > 0) {
        console.log('TEXT OVERLAPS FOUND:');
        for (const o of overlaps) console.log(`  - ${o}`);
      }
      expect(
        overlaps,
        `Found ${overlaps.length} text/text overlaps:\n${overlaps.join('\n')}`
      ).toHaveLength(0);
    });

    test('no text elements overlap with dashed boundary rects', async ({ page }) => {
      const overlaps = await page.evaluate(() => {
        const svg = document.querySelector('svg')!;
        const texts = Array.from(svg.querySelectorAll('text'));
        const rects = Array.from(svg.querySelectorAll('rect[stroke-dasharray]'));
        const issues: string[] = [];

        const EDGE_TOLERANCE = 6; // How close text can be to a dashed boundary edge

        for (const text of texts) {
          const content = text.textContent?.trim() || '';
          if (!content) continue;

          const tBox = (text as SVGTextElement).getBBox();

          for (const rect of rects) {
            const rx = parseFloat(rect.getAttribute('x') || '0');
            const ry = parseFloat(rect.getAttribute('y') || '0');
            const rw = parseFloat(rect.getAttribute('width') || '0');
            const rh = parseFloat(rect.getAttribute('height') || '0');

            // Check if text bbox crosses any edge of the dashed rect
            const edges = [
              { name: 'top', y: ry },
              { name: 'bottom', y: ry + rh },
            ];

            for (const edge of edges) {
              // Text crosses this horizontal edge if text spans it vertically
              // and overlaps horizontally
              if (
                tBox.y < edge.y + EDGE_TOLERANCE &&
                tBox.y + tBox.height > edge.y - EDGE_TOLERANCE &&
                tBox.x < rx + rw &&
                tBox.x + tBox.width > rx
              ) {
                // Check it's actually crossing/touching the edge (not fully inside)
                const textCenter = tBox.y + tBox.height / 2;
                const distToEdge = Math.abs(textCenter - edge.y);
                if (distToEdge < tBox.height / 2 + EDGE_TOLERANCE) {
                  // Exclude section labels that are intentionally at the top edge
                  const isLabel = tBox.y >= ry - 5 && tBox.y <= ry + 20;
                  const stroke = rect.getAttribute('stroke') || '';
                  if (!isLabel || distToEdge < 4) {
                    issues.push(
                      `TEXT "${content.substring(0, 40)}" crosses ${edge.name} edge of boundary(${rx},${ry},${rw}x${rh} stroke=${stroke}): ` +
                        `text at y=${Math.round(tBox.y)}-${Math.round(tBox.y + tBox.height)}, edge at y=${edge.y}`
                    );
                  }
                }
              }
            }
          }
        }

        return issues;
      });

      if (overlaps.length > 0) {
        console.log('BOUNDARY OVERLAPS FOUND:');
        for (const o of overlaps) console.log(`  - ${o}`);
      }
      expect(
        overlaps,
        `Found ${overlaps.length} text/boundary overlaps:\n${overlaps.join('\n')}`
      ).toHaveLength(0);
    });
  });
}
