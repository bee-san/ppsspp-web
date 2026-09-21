/**
 * Port of MeikiPop `Popup.move_to` positioning (src/meikipop/gui/popup.py @
 * ed1b70c40f38a6bd397e277ed4106c26d34dab97), applied to the player viewport
 * instead of the OS monitor. Pure function; no DOM.
 */
import type { CssRect, PopupPositionMode } from './ocr-types';

/** MeikiPop's `offset = 15` (CSS px here). */
export const POPUP_GAP_PX = 15;

export interface PopupSize {
  width: number;
  height: number;
}

export function positionPopup(
  x: number,
  y: number,
  size: PopupSize,
  bounds: CssRect,
  mode: PopupPositionMode,
  offset = POPUP_GAP_PX,
): { left: number; top: number } {
  const left = bounds.left;
  const top = bounds.top;
  // Qt's QRect.right()/bottom() are inclusive (left + width - 1); reproduce that.
  const right = bounds.left + bounds.width - 1;
  const bottom = bounds.top + bounds.height - 1;
  let finalX: number;
  let finalY: number;

  if (mode === 'visual_novel_mode') {
    const screenHeight = bounds.height;
    const cursorYInScreen = y - top;
    let isBelow: boolean;
    if (cursorYInScreen > (2 * screenHeight) / 3) isBelow = false;
    else if (cursorYInScreen < screenHeight / 3) isBelow = true;
    else isBelow = cursorYInScreen < screenHeight / 2;
    finalY = isBelow ? y + offset : y - size.height - offset;
    if (finalY < top) finalY = top;
    if (finalY + size.height > bottom) finalY = bottom - size.height;

    const screenWidth = bounds.width;
    const cursorXInScreen = x - left;
    const posRight = x + offset;
    const posCenter = x - size.width / 2;
    const posLeft = x - size.width - offset;
    if (cursorXInScreen < screenWidth / 2) {
      const ratio = cursorXInScreen / (screenWidth / 2);
      finalX = posRight * (1 - ratio) + posCenter * ratio;
    } else {
      const ratio = (cursorXInScreen - screenWidth / 2) / (screenWidth / 2);
      finalX = posCenter * (1 - ratio) + posLeft * ratio;
    }
  } else if (mode === 'flip_horizontally') {
    const preferredX = x + offset;
    finalX = preferredX + size.width <= right ? preferredX : x - size.width - offset;
    finalY = y + offset;
    if (finalY + size.height > bottom) finalY = bottom - size.height;
    if (finalY < top) finalY = top;
  } else if (mode === 'flip_vertically') {
    finalX = x + offset;
    if (finalX + size.width > right) finalX = right - size.width;
    if (finalX < left) finalX = left;
    const preferredY = y + offset;
    finalY = preferredY + size.height <= bottom ? preferredY : y - size.height - offset;
  } else {
    const preferredX = x + offset;
    finalX = preferredX + size.width <= right ? preferredX : x - size.width - offset;
    const preferredY = y + offset;
    finalY = preferredY + size.height <= bottom ? preferredY : y - size.height - offset;
  }

  finalX = Math.max(left, Math.min(finalX, right - size.width));
  finalY = Math.max(top, Math.min(finalY, bottom - size.height));
  return { left: Math.trunc(finalX), top: Math.trunc(finalY) };
}

/**
 * Browser adaptation: a hover corridor between the pointer's last source
 * position and the popup so the user can move into the card without it
 * vanishing. Returns true when `pt` lies within the corridor/popup (+margin).
 */
export function isInPopupCorridor(
  pt: { x: number; y: number },
  from: { x: number; y: number },
  popup: CssRect,
  margin = 24,
): boolean {
  const px0 = popup.left - margin;
  const py0 = popup.top - margin;
  const px1 = popup.left + popup.width + margin;
  const py1 = popup.top + popup.height + margin;
  if (pt.x >= px0 && pt.x <= px1 && pt.y >= py0 && pt.y <= py1) return true;
  // Corridor = bounding box of the origin point and the popup rect (with margin).
  const bx0 = Math.min(from.x - margin, px0);
  const by0 = Math.min(from.y - margin, py0);
  const bx1 = Math.max(from.x + margin, px1);
  const by1 = Math.max(from.y + margin, py1);
  return pt.x >= bx0 && pt.x <= bx1 && pt.y >= by0 && pt.y <= by1;
}
