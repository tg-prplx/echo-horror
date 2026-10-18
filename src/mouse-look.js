// A recenter/warp packet must not become a single-event camera cut. Normal
// mouse and touchpad packets retain their exact delta, without smoothing.
const MAX_PACKET_TURN = Math.PI / 3;

export class MouseLook {
  constructor(turn) {
    this.turn = turn;
    this.locked = false;
    this.reset();
  }

  reset() {
    this.drag = null;
    this.prime = true;
  }

  setLocked(locked) {
    this.locked = locked;
    this.reset();
  }

  beginDrag(x, y) {
    this.drag = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  endDrag() { this.drag = null; }

  move(event, sensitivity) {
    if (!Number.isFinite(sensitivity) || sensitivity <= 0 || event.sourceCapabilities?.firesTouchEvents) return;
    let dx, dy;
    if (this.locked) {
      // Locking or regaining focus can recenter the system cursor.
      if (this.prime) { this.prime = false; return; }
      dx = event.movementX; dy = event.movementY;
    } else if (this.drag) {
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      // movementX is relative to other browser events, not our drag origin.
      dx = event.clientX - this.drag.x; dy = event.clientY - this.drag.y;
      this.drag = { x: event.clientX, y: event.clientY };
    } else return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (Math.max(Math.abs(dx), Math.abs(dy)) * sensitivity > MAX_PACKET_TURN) return;
    this.turn(dx, dy, sensitivity);
  }
}
