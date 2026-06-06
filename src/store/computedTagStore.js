class ComputedTagStore {
  constructor() {
    this.tags = new Map();
  }

  addTag(tag) {
    this.tags.set(tag.id, {
      ...tag,
      timer: null,
      currentValue: tag.currentValue || null
    });
  }

  hasTag(tagId) {
    return this.tags.has(tagId);
  }

  removeTag(tagId) {
    const t = this.tags.get(tagId);
    if (t && t.timer) {
      clearInterval(t.timer);
    }
    this.tags.delete(tagId);
  }

  updateValue(tagId, value) {
    const t = this.tags.get(tagId);
    if (t) {
      t.currentValue = value;
    }
  }

  getValue(tagId) {
    const t = this.tags.get(tagId);
    return t ? t.currentValue : null;
  }

  setTimer(tagId, timer) {
    const t = this.tags.get(tagId);
    if (t) {
      t.timer = timer;
    }
  }

  getAll() {
    const result = [];
    for (const [id, t] of this.tags.entries()) {
      result.push({
        id,
        name: t.name,
        expression: t.expression,
        sourceRegisters: t.sourceRegisters,
        interval_ms: t.interval_ms,
        currentValue: t.currentValue
      });
    }
    return result;
  }

  clearAllTimers() {
    for (const t of this.tags.values()) {
      if (t.timer) {
        clearInterval(t.timer);
        t.timer = null;
      }
    }
  }
}

module.exports = new ComputedTagStore();
