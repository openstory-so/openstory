/**
 * Equal-cell crop geometry for a variant contact sheet.
 *
 * The picker CSS and the server crop must agree: both slice the sheet into
 * `gridCols × gridRows` equal cells, then inset each cell so leftover model
 * bleed / gutter doesn't survive into the upscale.
 */

/** Fraction of each cell discarded on every edge (5% → keep the inner 90%). */
export const VARIANT_TILE_INSET = 0.05;

export type TileCropRect = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Cloudflare Image Resizing `trim=T;R;B;L` (pixels removed from each edge). */
  trim: string;
};

export function tileCropRect(options: {
  gridWidth: number;
  gridHeight: number;
  /** 1-based, top row = 1. */
  row: number;
  /** 1-based, left column = 1. */
  col: number;
  gridCols: number;
  gridRows: number;
  inset?: number;
}): TileCropRect {
  const {
    gridWidth,
    gridHeight,
    row,
    col,
    gridCols,
    gridRows,
    inset = VARIANT_TILE_INSET,
  } = options;

  if (row < 1 || row > gridRows || col < 1 || col > gridCols) {
    throw new Error(
      `Invalid tile position: row ${row}, col ${col}. Must be 1-${gridRows} and 1-${gridCols}.`
    );
  }
  if (inset < 0 || inset >= 0.5) {
    throw new Error(`Tile inset must be in [0, 0.5), got ${inset}`);
  }

  const tileWidth = Math.floor(gridWidth / gridCols);
  const tileHeight = Math.floor(gridHeight / gridRows);
  const insetX = Math.floor(tileWidth * inset);
  const insetY = Math.floor(tileHeight * inset);
  const x1 = tileWidth * (col - 1) + insetX;
  const y1 = tileHeight * (row - 1) + insetY;
  const x2 = tileWidth * col - insetX;
  const y2 = tileHeight * row - insetY;
  if (x2 <= x1 || y2 <= y1) {
    throw new Error(
      `Degenerate tile crop at row ${row}, col ${col} (${x1},${y1})–(${x2},${y2})`
    );
  }

  return {
    x1,
    y1,
    x2,
    y2,
    trim: `${y1};${gridWidth - x2};${gridHeight - y2};${x1}`,
  };
}

/**
 * CSS `background-size` / `background-position` that shows the same inset
 * cell the server crop uses. Pure fractions — no need for the sheet's pixel
 * size.
 */
export function tileBackgroundCss(options: {
  index: number;
  gridCols: number;
  gridRows: number;
  inset?: number;
}): { backgroundSize: string; backgroundPosition: string } {
  const {
    index,
    gridCols: cols,
    gridRows: rows,
    inset = VARIANT_TILE_INSET,
  } = options;
  const row = Math.floor(index / cols);
  const col = index % cols;
  const cellW = 1 / cols;
  const cellH = 1 / rows;
  const cropW = cellW * (1 - 2 * inset);
  const cropH = cellH * (1 - 2 * inset);
  const cropX = col * cellW + cellW * inset;
  const cropY = row * cellH + cellH * inset;
  const bgPosX = cropW >= 1 ? 0 : (cropX / (1 - cropW)) * 100;
  const bgPosY = cropH >= 1 ? 0 : (cropY / (1 - cropH)) * 100;
  return {
    backgroundSize: `${fmtPct(100 / cropW)}% ${fmtPct(100 / cropH)}%`,
    backgroundPosition: `${fmtPct(bgPosX)}% ${fmtPct(bgPosY)}%`,
  };
}

function fmtPct(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}
