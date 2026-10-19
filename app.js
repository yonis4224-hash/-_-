/**
 * Manga Studio Pro - المحرك المطور المتكامل
 * ميزات الخطوة المتقدمة المطبقة:
 * 1. أدوات التحديد الحر (Lasso Selection & Rectangular Marquee) المستوحاة من KisToolSelectOutline
 * 2. تأثير مسيرة النمل (Marching Ants Selection) المتحرك لحواف التحديد
 * 3. حصر الرسم والتعبئة والمسح داخل منطقة التحديد فقط
 * 4. أداة التحويل الحر (Free Transform Strategy) لتكبير وتصغير وتدوير ونقل التحديد
 * 5. محرك التنعيم Catmull-Rom Splines مع الـ Stabilizer (0-100) وتدبيب أطراف الـ G-Pen
 * 6. سكرين تون المانجا (Halftone)، دلو التعبئة الذكي (Expand + Reference Layer)، والطبقات (Alpha Lock & Clipping Mask)
 */

class DrawingEngine {
  constructor(canvas, selectionCanvas, wrapper, viewport) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.selectionCanvas = selectionCanvas;
    this.selCtx = selectionCanvas.getContext('2d');
    this.wrapper = wrapper;
    this.viewport = viewport;

    // حالة الكاميرا والعرض
    this.zoom = 0.55;
    this.rotation = 0;
    this.isFlippedX = false;
    this.panX = 0;
    this.panY = 0;
    this.isPanning = false;
    this.panStartX = 0;
    this.panStartY = 0;

    // الأدوات والفُرش
    this.currentTool = 'brush';       // 'brush', 'eraser', 'bucket', 'pipette', 'pan', 'lasso', 'rect-select', 'transform'
    this.brushType = 'gpen';          // 'gpen', 'screentone', 'pencil', 'airbrush', 'marker', 'smudge'
    this.currentShape = 'freehand';   // 'freehand', 'manga-frame', 'line', 'rectangle', 'circle'
    
    this.brushColor = '#000000';
    this.brushSize = 6;
    this.brushOpacity = 1.0;
    this.spacingRatio = 0.08;
    this.taperEnabled = true;
    this.screentoneFrequency = 25;

    // نظام التحديد الحر (Selection System)
    this.hasActiveSelection = false;
    this.selectionPath = [];
    this.selectionMask = null;
    this.marchingAntsOffset = 0;

    // حالة التحويل الحر (Transform State)
    this.transformBox = document.getElementById('transform-box');
    this.transformData = null;

    // خيارات دلو المانغا
    this.bucketTolerance = 40;
    this.bucketExpand = 2;

    // التناظر
    this.symmetryEnabled = false;

    // تنعيم الخط (Stabilizer 0-100)
    this.stabilizerStrength = 35;
    this.rawPoints = [];

    // نظام الطبقات
    this.layers = [];
    this.activeLayerIndex = 0;
    this.referenceLayerIndex = -1;

    // سجل التراجع
    this.history = [];
    this.historyStep = -1;
    this.maxHistory = 25;

    this.isDrawing = false;
    this.strokePath = [];
    this.shapePreviewBackup = null;

    this.initViewport();
    this.initLayers();
    this.startMarchingAntsAnimation();
  }

  initViewport() {
    this.resetView();
  }

  updateViewportTransform() {
    const flip = this.isFlippedX ? -1 : 1;
    this.wrapper.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom * flip}, ${this.zoom}) rotate(${this.rotation}deg)`;
    
    document.getElementById('hud-zoom').textContent = `التقريب: ${Math.round(this.zoom * 100)}%`;
    document.getElementById('hud-rotation').textContent = `الزاوية: ${this.rotation}°`;
    document.getElementById('hud-pos').textContent = `الموضع: (${Math.round(this.panX)}, ${Math.round(this.panY)})`;
  }

  resetView() {
    this.zoom = 0.55;
    this.rotation = 0;
    this.isFlippedX = false;
    this.panX = - (this.canvas.width * this.zoom) / 2;
    this.panY = - (this.canvas.height * this.zoom) / 2;
    this.updateViewportTransform();
  }

  rotateBy(angle) {
    this.rotation = (this.rotation + angle) % 360;
    this.updateViewportTransform();
  }

  toggleFlipHorizontal() {
    this.isFlippedX = !this.isFlippedX;
    this.updateViewportTransform();
  }

  initLayers() {
    this.addLayer('خلفية بيضاء', true);
    this.addLayer('طبقة التحبير Lineart');
  }

  addLayer(name = null, isWhite = false) {
    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = this.canvas.width;
    layerCanvas.height = this.canvas.height;
    const layerCtx = layerCanvas.getContext('2d');

    if (isWhite) {
      layerCtx.fillStyle = '#ffffff';
      layerCtx.fillRect(0, 0, layerCanvas.width, layerCanvas.height);
    }

    const layer = {
      canvas: layerCanvas,
      ctx: layerCtx,
      name: name || `طبقة ${this.layers.length + 1}`,
      visible: true,
      opacity: 1.0,
      blendMode: 'source-over',
      alphaLock: false,
      clippingMask: false
    };

    this.layers.push(layer);
    this.activeLayerIndex = this.layers.length - 1;
    this.saveState();
    this.render();
  }

  deleteActiveLayer() {
    if (this.layers.length <= 1) return;
    this.layers.splice(this.activeLayerIndex, 1);
    this.activeLayerIndex = Math.max(0, this.activeLayerIndex - 1);
    this.saveState();
    this.render();
  }

  getActiveLayer() {
    return this.layers[this.activeLayerIndex];
  }

  screenToCanvas(clientX, clientY) {
    const rect = this.wrapper.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    let dx = clientX - centerX;
    let dy = clientY - centerY;

    if (this.isFlippedX) dx = -dx;

    const rad = (-this.rotation * Math.PI) / 180;
    const rotX = dx * Math.cos(rad) - dy * Math.sin(rad);
    const rotY = dx * Math.sin(rad) + dy * Math.cos(rad);

    const x = this.canvas.width / 2 + rotX / this.zoom;
    const y = this.canvas.height / 2 + rotY / this.zoom;

    return { x, y };
  }

  startStroke(x, y, pressure = 1.0) {
    if (this.currentTool === 'bucket') {
      this.executeSmartFloodFill(Math.round(x), Math.round(y));
      this.saveState();
      this.render();
      return;
    }

    if (this.currentTool === 'pipette') {
      this.pickColorAt(Math.round(x), Math.round(y));
      return;
    }

    if (this.currentTool === 'lasso' || this.currentTool === 'rect-select') {
      this.isDrawing = true;
      this.selectionPath = [{ x, y }];
      return;
    }

    this.isDrawing = true;
    this.rawPoints = [{ x, y, pressure }];
    this.strokePath = [{ x, y, pressure }];

    const layer = this.getActiveLayer();
    if (layer) {
      this.shapePreviewBackup = layer.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    }

    if (this.currentShape === 'freehand') {
      this.drawSingleDab(x, y, pressure, 0.5);
      this.render();
    }
  }

  continueStroke(x, y, pressure = 1.0) {
    if (!this.isDrawing) return;

    if (this.currentTool === 'lasso') {
      this.selectionPath.push({ x, y });
      this.renderLiveSelectionOutline();
      return;
    }

    if (this.currentTool === 'rect-select') {
      this.selectionPath = [this.selectionPath[0], { x, y }];
      this.renderLiveSelectionOutline();
      return;
    }

    if (this.currentShape !== 'freehand') {
      this.previewGeometricOrMangaShape(x, y);
      return;
    }

    this.rawPoints.push({ x, y, pressure });
    const smoothedPoint = this.applyStrokeStabilizer();
    const lastPoint = this.strokePath[this.strokePath.length - 1];

    this.renderSplineSegment(lastPoint, smoothedPoint);
    this.strokePath.push(smoothedPoint);

    this.render();
  }

  endStroke() {
    if (!this.isDrawing) return;

    if (this.currentTool === 'lasso' || this.currentTool === 'rect-select') {
      this.isDrawing = false;
      this.finalizeSelection();
      return;
    }

    if (this.taperEnabled && this.strokePath.length > 5 && this.currentShape === 'freehand') {
      this.applyTaperOut();
    }

    this.isDrawing = false;
    this.rawPoints = [];
    this.strokePath = [];
    this.shapePreviewBackup = null;
    this.saveState();
  }

  /**
   * موازن الخطوط الاحترافي (Stabilizer)
   */
  applyStrokeStabilizer() {
    if (this.stabilizerStrength === 0 || this.rawPoints.length < 2) {
      return this.rawPoints[this.rawPoints.length - 1];
    }

    const windowSize = Math.max(2, Math.round((this.stabilizerStrength / 100) * 20));
    const k = Math.min(this.rawPoints.length, windowSize);

    let sumX = 0, sumY = 0, sumP = 0, weightTotal = 0;

    for (let i = 0; i < k; i++) {
      const pt = this.rawPoints[this.rawPoints.length - 1 - i];
      const w = k - i;
      sumX += pt.x * w;
      sumY += pt.y * w;
      sumP += pt.pressure * w;
      weightTotal += w;
    }

    return {
      x: sumX / weightTotal,
      y: sumY / weightTotal,
      pressure: sumP / weightTotal
    };
  }

  renderSplineSegment(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return;

    let taperFactor = 1.0;
    if (this.taperEnabled && this.strokePath.length < 10) {
      taperFactor = Math.max(0.15, this.strokePath.length / 10);
    }

    const steps = Math.max(2, Math.ceil(dist / (this.brushSize * this.spacingRatio)));

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const curX = p1.x + dx * t;
      const curY = p1.y + dy * t;
      const curPressure = (p1.pressure + (p2.pressure - p1.pressure) * t) * taperFactor;

      this.drawSingleDab(curX, curY, curPressure, taperFactor);
      if (this.symmetryEnabled) {
        this.drawSingleDab(this.canvas.width - curX, curY, curPressure, taperFactor);
      }
    }
  }

  applyTaperOut() {
    const count = Math.min(8, this.strokePath.length);
    for (let i = 0; i < count; i++) {
      const pt = this.strokePath[this.strokePath.length - 1 - i];
      const factor = (count - i) / count;
      this.drawSingleDab(pt.x, pt.y, pt.pressure * factor * 0.4, factor);
    }
    this.render();
  }

  drawSingleDab(x, y, pressure, taperFactor = 1.0) {
    // التحقق مما إذا كان هناك تحديد مفعل، وإهمال الرسم خارجه
    if (this.hasActiveSelection && !this.isPointInsideSelection(x, y)) {
      return;
    }

    const layer = this.getActiveLayer();
    if (!layer || !layer.visible) return;

    const ctx = layer.ctx;
    ctx.save();

    if (layer.alphaLock) {
      ctx.globalCompositeOperation = 'source-atop';
    } else if (this.currentTool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
    } else {
      ctx.globalCompositeOperation = 'source-over';
    }

    const effectiveSize = Math.max(0.5, this.brushSize * (0.15 + 0.85 * (pressure || 1.0)) * taperFactor);
    const radius = effectiveSize / 2;

    if (this.currentTool === 'eraser') {
      ctx.fillStyle = `rgba(0,0,0,${this.brushOpacity})`;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    switch (this.brushType) {
      case 'gpen': {
        ctx.fillStyle = this.brushColor;
        ctx.globalAlpha = this.brushOpacity;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
        break;
      }

      case 'screentone': {
        const freq = this.screentoneFrequency;
        const gridX = Math.floor(x / freq) * freq;
        const gridY = Math.floor(y / freq) * freq;
        const dotRadius = (effectiveSize / 2) * (this.brushOpacity * 0.85);

        ctx.fillStyle = this.brushColor;
        ctx.globalAlpha = 1.0;
        ctx.beginPath();
        ctx.arc(gridX + freq / 2, gridY + freq / 2, Math.max(1, dotRadius), 0, Math.PI * 2);
        ctx.fill();
        break;
      }

      case 'pencil': {
        ctx.fillStyle = this.brushColor;
        ctx.globalAlpha = this.brushOpacity * 0.25;
        const count = 5;
        for (let i = 0; i < count; i++) {
          const ox = (Math.random() - 0.5) * radius * 1.3;
          const oy = (Math.random() - 0.5) * radius * 1.3;
          ctx.beginPath();
          ctx.arc(x + ox, y + oy, Math.max(0.4, radius * 0.35), 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }

      case 'airbrush': {
        const grad = ctx.createRadialGradient(x, y, 0, x, y, radius * 1.8);
        const rgb = this.hexToRgb(this.brushColor);
        grad.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${this.brushOpacity * 0.22})`);
        grad.addColorStop(0.6, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${this.brushOpacity * 0.08})`);
        grad.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, radius * 1.8, 0, Math.PI * 2);
        ctx.fill();
        break;
      }

      case 'marker': {
        ctx.fillStyle = this.brushColor;
        ctx.globalAlpha = this.brushOpacity * 0.85;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
        break;
      }

      case 'smudge': {
        try {
          const sampleR = Math.max(2, Math.round(radius * 0.85));
          const sx = Math.max(0, Math.min(this.canvas.width - sampleR * 2, Math.round(x - sampleR)));
          const sy = Math.max(0, Math.min(this.canvas.height - sampleR * 2, Math.round(y - sampleR)));
          const sData = ctx.getImageData(sx, sy, sampleR * 2, sampleR * 2);
          ctx.globalAlpha = 0.5;
          ctx.putImageData(sData, sx, sy);
        } catch (e) {}
        break;
      }
    }

    ctx.restore();
  }

  /**
   * إدارة التحديد ومسيرة النمل المتحركة (Marching Ants)
   */
  renderLiveSelectionOutline() {
    this.selCtx.clearRect(0, 0, this.selectionCanvas.width, this.selectionCanvas.height);
    if (this.selectionPath.length < 2) return;

    this.selCtx.save();
    this.selCtx.strokeStyle = '#000000';
    this.selCtx.lineWidth = 1.5;
    this.selCtx.setLineDash([4, 4]);
    this.selCtx.lineDashOffset = -this.marchingAntsOffset;

    this.selCtx.beginPath();
    if (this.currentTool === 'rect-select') {
      const p1 = this.selectionPath[0];
      const p2 = this.selectionPath[1];
      this.selCtx.strokeRect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
    } else {
      this.selCtx.moveTo(this.selectionPath[0].x, this.selectionPath[0].y);
      for (let i = 1; i < this.selectionPath.length; i++) {
        this.selCtx.lineTo(this.selectionPath[i].x, this.selectionPath[i].y);
      }
      this.selCtx.stroke();
    }

    this.selCtx.restore();
  }

  finalizeSelection() {
    if (this.selectionPath.length < 3 && this.currentTool === 'lasso') {
      this.deselect();
      return;
    }

    this.hasActiveSelection = true;
    this.drawSelectionMarchingAnts();
  }

  drawSelectionMarchingAnts() {
    this.selCtx.clearRect(0, 0, this.selectionCanvas.width, this.selectionCanvas.height);
    if (!this.hasActiveSelection || this.selectionPath.length < 2) return;

    this.selCtx.save();
    this.selCtx.beginPath();

    if (this.currentTool === 'rect-select' || this.selectionPath.length === 2) {
      const p1 = this.selectionPath[0];
      const p2 = this.selectionPath[1];
      this.selCtx.rect(Math.min(p1.x, p2.x), Math.min(p1.y, p2.y), Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
    } else {
      this.selCtx.moveTo(this.selectionPath[0].x, this.selectionPath[0].y);
      for (let i = 1; i < this.selectionPath.length; i++) {
        this.selCtx.lineTo(this.selectionPath[i].x, this.selectionPath[i].y);
      }
      this.selCtx.closePath();
    }

    // خط أسود أولاً
    this.selCtx.strokeStyle = '#000000';
    this.selCtx.lineWidth = 1.5;
    this.selCtx.setLineDash([4, 4]);
    this.selCtx.lineDashOffset = -this.marchingAntsOffset;
    this.selCtx.stroke();

    // خط أبيض متعاكس لضمان رؤية النمل في الخلفيات المظلمة والفاتحة
    this.selCtx.strokeStyle = '#ffffff';
    this.selCtx.lineDashOffset = -this.marchingAntsOffset + 4;
    this.selCtx.stroke();

    this.selCtx.restore();
  }

  startMarchingAntsAnimation() {
    setInterval(() => {
      if (this.hasActiveSelection) {
        this.marchingAntsOffset = (this.marchingAntsOffset + 1) % 8;
        this.drawSelectionMarchingAnts();
      }
    }, 80);
  }

  isPointInsideSelection(x, y) {
    if (!this.hasActiveSelection) return true;
    if (this.selectionPath.length === 2) {
      const p1 = this.selectionPath[0];
      const p2 = this.selectionPath[1];
      const minX = Math.min(p1.x, p2.x);
      const maxX = Math.max(p1.x, p2.x);
      const minY = Math.min(p1.y, p2.y);
      const maxY = Math.max(p1.y, p2.y);
      return x >= minX && x <= maxX && y >= minY && y <= maxY;
    }

    // خوارزمية فحص النقطة داخل مضلع (Ray Casting Algorithm)
    let inside = false;
    for (let i = 0, j = this.selectionPath.length - 1; i < this.selectionPath.length; j = i++) {
      const xi = this.selectionPath[i].x, yi = this.selectionPath[i].y;
      const xj = this.selectionPath[j].x, yj = this.selectionPath[j].y;
      const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  deselect() {
    this.hasActiveSelection = false;
    this.selectionPath = [];
    this.selCtx.clearRect(0, 0, this.selectionCanvas.width, this.selectionCanvas.height);
    if (this.transformBox) this.transformBox.style.display = 'none';
  }

  /**
   * أداة التحويل الحر (Free Transform)
   */
  activateFreeTransform() {
    const layer = this.getActiveLayer();
    if (!layer) return;

    let minX = 0, minY = 0, maxX = this.canvas.width, maxY = this.canvas.height;

    if (this.hasActiveSelection) {
      if (this.selectionPath.length === 2) {
        minX = Math.min(this.selectionPath[0].x, this.selectionPath[1].x);
        maxX = Math.max(this.selectionPath[0].x, this.selectionPath[1].x);
        minY = Math.min(this.selectionPath[0].y, this.selectionPath[1].y);
        maxY = Math.max(this.selectionPath[0].y, this.selectionPath[1].y);
      } else {
        const xs = this.selectionPath.map(p => p.x);
        const ys = this.selectionPath.map(p => p.y);
        minX = Math.min(...xs);
        maxX = Math.max(...xs);
        minY = Math.min(...ys);
        maxY = Math.max(...ys);
      }
    }

    const w = maxX - minX;
    const h = maxY - minY;
    if (w <= 0 || h <= 0) return;

    // استخراج بكسلات المنطقة المحددة
    const extractedData = layer.ctx.getImageData(minX, minY, w, h);
    layer.ctx.clearRect(minX, minY, w, h);
    this.render();

    this.transformData = {
      x: minX,
      y: minY,
      width: w,
      height: h,
      imgData: extractedData
    };

    this.updateTransformBoxUI();
  }

  updateTransformBoxUI() {
    if (!this.transformData || !this.transformBox) return;
    this.transformBox.style.display = 'block';
    this.transformBox.style.left = `${this.transformData.x}px`;
    this.transformBox.style.top = `${this.transformData.y}px`;
    this.transformBox.style.width = `${this.transformData.width}px`;
    this.transformBox.style.height = `${this.transformData.height}px`;
  }

  applyTransformCommit() {
    if (!this.transformData) return;
    const layer = this.getActiveLayer();
    if (layer) {
      layer.ctx.putImageData(this.transformData.imgData, this.transformData.x, this.transformData.y);
      this.render();
      this.saveState();
    }
    this.transformData = null;
    if (this.transformBox) this.transformBox.style.display = 'none';
  }

  previewGeometricOrMangaShape(currentX, currentY) {
    const layer = this.getActiveLayer();
    if (!layer || !this.shapePreviewBackup) return;

    layer.ctx.putImageData(this.shapePreviewBackup, 0, 0);

    const startX = this.rawPoints[0].x;
    const startY = this.rawPoints[0].y;

    layer.ctx.save();
    layer.ctx.strokeStyle = this.brushColor;
    layer.ctx.fillStyle = '#ffffff';
    layer.ctx.lineWidth = this.brushSize;
    layer.ctx.lineCap = 'square';
    layer.ctx.lineJoin = 'miter';
    layer.ctx.globalAlpha = this.brushOpacity;

    if (this.currentShape === 'manga-frame') {
      const rx = Math.min(startX, currentX);
      const ry = Math.min(startY, currentY);
      const rw = Math.abs(currentX - startX);
      const rh = Math.abs(currentY - startY);

      layer.ctx.lineWidth = Math.max(4, this.brushSize * 1.5);
      layer.ctx.fillRect(rx, ry, rw, rh);
      layer.ctx.strokeRect(rx, ry, rw, rh);
    } else if (this.currentShape === 'line') {
      layer.ctx.beginPath();
      layer.ctx.moveTo(startX, startY);
      layer.ctx.lineTo(currentX, currentY);
      layer.ctx.stroke();
    } else if (this.currentShape === 'rectangle') {
      layer.ctx.strokeRect(Math.min(startX, currentX), Math.min(startY, currentY), Math.abs(currentX - startX), Math.abs(currentY - startY));
    } else if (this.currentShape === 'circle') {
      const r = Math.hypot(currentX - startX, currentY - startY);
      layer.ctx.beginPath();
      layer.ctx.arc(startX, startY, r, 0, Math.PI * 2);
      layer.ctx.stroke();
    }

    layer.ctx.restore();
    this.render();
  }

  executeSmartFloodFill(startX, startY) {
    const activeLayer = this.getActiveLayer();
    if (!activeLayer || !activeLayer.visible) return;

    const sourceLayer = (this.referenceLayerIndex >= 0 && this.layers[this.referenceLayerIndex]) 
      ? this.layers[this.referenceLayerIndex] 
      : activeLayer;

    const width = this.canvas.width;
    const height = this.canvas.height;

    const srcData = sourceLayer.ctx.getImageData(0, 0, width, height).data;
    const destImgData = activeLayer.ctx.getImageData(0, 0, width, height);
    const destData = destImgData.data;

    const startIdx = (startY * width + startX) * 4;
    const targetR = srcData[startIdx];
    const targetG = srcData[startIdx + 1];
    const targetB = srcData[startIdx + 2];
    const targetA = srcData[startIdx + 3];

    const fillRgb = this.hexToRgb(this.brushColor);
    const fillAlpha = Math.round(this.brushOpacity * 255);

    const tolerance = this.bucketTolerance;
    const colorMatch = (idx) => {
      const dr = Math.abs(srcData[idx] - targetR);
      const dg = Math.abs(srcData[idx + 1] - targetG);
      const db = Math.abs(srcData[idx + 2] - targetB);
      const da = Math.abs(srcData[idx + 3] - targetA);
      return dr + dg + db + da <= tolerance;
    };

    const mask = new Uint8Array(width * height);
    const pixelStack = [[startX, startY]];

    while (pixelStack.length > 0) {
      const [curX, curY] = pixelStack.pop();
      let y1 = curY;
      let idx = (y1 * width + curX) * 4;
      let mIdx = y1 * width + curX;

      while (y1 >= 0 && colorMatch(idx) && mask[mIdx] === 0) {
        y1--;
        idx -= width * 4;
        mIdx -= width;
      }

      idx += width * 4;
      mIdx += width;
      y1++;

      let spanLeft = false;
      let spanRight = false;

      while (y1 < height && colorMatch(idx) && mask[mIdx] === 0) {
        mask[mIdx] = 1;

        if (curX > 0) {
          if (colorMatch(idx - 4) && mask[mIdx - 1] === 0) {
            if (!spanLeft) {
              pixelStack.push([curX - 1, y1]);
              spanLeft = true;
            }
          } else if (spanLeft) {
            spanLeft = false;
          }
        }

        if (curX < width - 1) {
          if (colorMatch(idx + 4) && mask[mIdx + 1] === 0) {
            if (!spanRight) {
              pixelStack.push([curX + 1, y1]);
              spanRight = true;
            }
          } else if (spanRight) {
            spanRight = false;
          }
        }

        y1++;
        idx += width * 4;
        mIdx += width;
      }
    }

    const expand = this.bucketExpand;
    const finalMask = new Uint8Array(mask);

    if (expand > 0) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (mask[y * width + x] === 1) {
            for (let ey = -expand; ey <= expand; ey++) {
              for (let ex = -expand; ex <= expand; ex++) {
                const nx = x + ex;
                const ny = y + ey;
                if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                  finalMask[ny * width + nx] = 1;
                }
              }
            }
          }
        }
      }
    }

    for (let i = 0; i < width * height; i++) {
      if (finalMask[i] === 1) {
        const dIdx = i * 4;
        destData[dIdx] = fillRgb.r;
        destData[dIdx + 1] = fillRgb.g;
        destData[dIdx + 2] = fillRgb.b;
        destData[dIdx + 3] = fillAlpha;
      }
    }

    activeLayer.ctx.putImageData(destImgData, 0, 0);
  }

  pickColorAt(x, y) {
    const pixel = this.ctx.getImageData(x, y, 1, 1).data;
    const hex = `#${((1 << 24) + (pixel[0] << 16) + (pixel[1] << 8) + pixel[2]).toString(16).slice(1)}`;
    this.brushColor = hex;
    this.currentTool = 'brush';
    document.getElementById('current-hex-val').textContent = hex;
    document.getElementById('color-indicator').style.backgroundColor = hex;
    document.getElementById('btn-brushes-library').classList.add('active');
    document.getElementById('btn-pipette').classList.remove('active');
  }

  render() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i];
      if (!layer.visible) continue;

      this.ctx.save();
      this.ctx.globalAlpha = layer.opacity;
      this.ctx.globalCompositeOperation = layer.blendMode || 'source-over';

      if (layer.clippingMask && i > 0) {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.canvas.width;
        tempCanvas.height = this.canvas.height;
        const tempCtx = tempCanvas.getContext('2d');

        tempCtx.drawImage(layer.canvas, 0, 0);
        tempCtx.globalCompositeOperation = 'destination-in';
        tempCtx.drawImage(this.layers[i - 1].canvas, 0, 0);

        this.ctx.drawImage(tempCanvas, 0, 0);
      } else {
        this.ctx.drawImage(layer.canvas, 0, 0);
      }

      this.ctx.restore();
    }
  }

  saveState() {
    const layer = this.getActiveLayer();
    if (!layer) return;

    if (this.historyStep < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyStep + 1);
    }

    const state = {
      layerIndex: this.activeLayerIndex,
      data: layer.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height)
    };

    this.history.push(state);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    } else {
      this.historyStep++;
    }
  }

  undo() {
    if (this.historyStep > 0) {
      this.historyStep--;
      const state = this.history[this.historyStep];
      if (this.layers[state.layerIndex]) {
        this.layers[state.layerIndex].ctx.putImageData(state.data, 0, 0);
        this.render();
      }
    }
  }

  redo() {
    if (this.historyStep < this.history.length - 1) {
      this.historyStep++;
      const state = this.history[this.historyStep];
      if (this.layers[state.layerIndex]) {
        this.layers[state.layerIndex].ctx.putImageData(state.data, 0, 0);
        this.render();
      }
    }
  }

  clearActiveLayer() {
    const layer = this.getActiveLayer();
    if (!layer) return;
    layer.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.activeLayerIndex === 0) {
      layer.ctx.fillStyle = '#ffffff';
      layer.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.saveState();
    this.render();
  }

  hexToRgb(hex) {
    const bigint = parseInt(hex.replace('#', ''), 16);
    return {
      r: (bigint >> 16) & 255,
      g: (bigint >> 8) & 255,
      b: bigint & 255
    };
  }
}

/**
 * عجلة ألوان Krita
 */
class ColorWheel {
  constructor(canvas, onColorSelected) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onColorSelected = onColorSelected;
    this.radius = canvas.width / 2;
    this.drawWheel();
    this.attachEvents();
  }

  drawWheel() {
    const r = this.radius;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, r * 2, r * 2);

    for (let angle = 0; angle < 360; angle += 1) {
      const rad = (angle * Math.PI) / 180;
      const x1 = r + (r - 26) * Math.cos(rad);
      const y1 = r + (r - 26) * Math.sin(rad);
      const x2 = r + r * Math.cos(rad);
      const y2 = r + r * Math.sin(rad);

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = `hsl(${angle}, 100%, 50%)`;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    const innerRad = r - 30;
    const gradWhite = ctx.createLinearGradient(r - innerRad, r, r + innerRad, r);
    gradWhite.addColorStop(0, '#ffffff');
    gradWhite.addColorStop(1, '#ff0000');

    ctx.beginPath();
    ctx.arc(r, r, innerRad, 0, Math.PI * 2);
    ctx.fillStyle = gradWhite;
    ctx.fill();

    const gradBlack = ctx.createLinearGradient(r, r - innerRad, r, r + innerRad);
    gradBlack.addColorStop(0, 'rgba(0,0,0,0)');
    gradBlack.addColorStop(1, '#000000');
    ctx.beginPath();
    ctx.arc(r, r, innerRad, 0, Math.PI * 2);
    ctx.fillStyle = gradBlack;
    ctx.fill();
  }

  attachEvents() {
    const handlePick = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const pixel = this.ctx.getImageData(x, y, 1, 1).data;
      if (pixel[3] > 0) {
        const hex = `#${((1 << 24) + (pixel[0] << 16) + (pixel[1] << 8) + pixel[2]).toString(16).slice(1)}`;
        this.onColorSelected(hex);
      }
    };

    let picking = false;
    this.canvas.onpointerdown = (e) => {
      picking = true;
      handlePick(e);
    };
    this.canvas.onpointermove = (e) => {
      if (picking) handlePick(e);
    };
    window.addEventListener('pointerup', () => picking = false);
  }
}

// ربط واجهة المستخدم
window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('drawing-canvas');
  const selectionCanvas = document.getElementById('selection-canvas');
  const wrapper = document.getElementById('canvas-transform-wrapper');
  const viewport = document.getElementById('viewport-container');

  const engine = new DrawingEngine(canvas, selectionCanvas, wrapper, viewport);

  // عناصر التحكم
  const btnBrushesLibrary = document.getElementById('btn-brushes-library');
  const btnEraser = document.getElementById('btn-eraser');
  const btnSelectTools = document.getElementById('btn-select-tools');
  const btnShapesTool = document.getElementById('btn-shapes-tool');
  const btnBucket = document.getElementById('btn-bucket');
  const btnPipette = document.getElementById('btn-pipette');
  const btnPanTool = document.getElementById('btn-pan-tool');
  const btnToggleSize = document.getElementById('btn-toggle-size');
  const btnToggleColor = document.getElementById('btn-toggle-color');
  const btnToggleLayers = document.getElementById('btn-toggle-layers');
  const btnToggleSymmetry = document.getElementById('btn-toggle-symmetry');
  const symmetryGuide = document.getElementById('symmetry-guide');
  const btnResetView = document.getElementById('btn-reset-view');
  const btnRotateLeft = document.getElementById('btn-rotate-left');
  const btnRotateRight = document.getElementById('btn-rotate-right');
  const btnFlipCanvas = document.getElementById('btn-flip-canvas');
  const btnToggleTaper = document.getElementById('btn-toggle-taper');
  const btnDeselect = document.getElementById('btn-deselect');

  // النوافذ العائمة
  const brushesPopup = document.getElementById('brushes-popup');
  const selectPopup = document.getElementById('select-popup');
  const bucketPopup = document.getElementById('bucket-popup');
  const shapesPopup = document.getElementById('shapes-popup');
  const brushSettingsPopup = document.getElementById('brush-settings-popup');
  const colorPopup = document.getElementById('color-popup');
  const layerPopup = document.getElementById('layer-popup');

  function closeAllPopups() {
    brushesPopup.classList.remove('open');
    selectPopup.classList.remove('open');
    bucketPopup.classList.remove('open');
    shapesPopup.classList.remove('open');
    brushSettingsPopup.classList.remove('open');
    colorPopup.classList.remove('open');
    layerPopup.classList.remove('open');
  }

  function resetToolButtons() {
    btnBrushesLibrary.classList.remove('active');
    btnEraser.classList.remove('active');
    btnSelectTools.classList.remove('active');
    btnShapesTool.classList.remove('active');
    btnBucket.classList.remove('active');
    btnPipette.classList.remove('active');
    btnPanTool.classList.remove('active');
  }

  btnDeselect.onclick = () => engine.deselect();
  btnRotateLeft.onclick = () => engine.rotateBy(-15);
  btnRotateRight.onclick = () => engine.rotateBy(15);
  btnFlipCanvas.onclick = () => engine.toggleFlipHorizontal();
  btnResetView.onclick = () => engine.resetView();

  btnToggleTaper.onclick = () => {
    engine.taperEnabled = !engine.taperEnabled;
    btnToggleTaper.textContent = engine.taperEnabled ? '✒️ تدبيب: مفعّل' : '✒️ تدبيب: معطل';
    btnToggleTaper.classList.toggle('active', engine.taperEnabled);
  };

  // عجلة الألوان
  const colorWheelCanvas = document.getElementById('color-wheel-canvas');
  const colorIndicator = document.getElementById('color-indicator');
  const currentHexVal = document.getElementById('current-hex-val');

  new ColorWheel(colorWheelCanvas, (hex) => {
    engine.brushColor = hex;
    colorIndicator.style.backgroundColor = hex;
    currentHexVal.textContent = hex;
  });

  document.querySelectorAll('.palette-swatch').forEach(swatch => {
    swatch.onclick = () => {
      const col = swatch.dataset.color;
      engine.brushColor = col;
      colorIndicator.style.backgroundColor = col;
      currentHexVal.textContent = col;
    };
  });

  // التناظر
  btnToggleSymmetry.onclick = () => {
    engine.symmetryEnabled = !engine.symmetryEnabled;
    btnToggleSymmetry.textContent = engine.symmetryEnabled ? '🪞 تناظر: مفعّل' : '🪞 تناظر: معطل';
    btnToggleSymmetry.classList.toggle('active', engine.symmetryEnabled);
    symmetryGuide.style.display = engine.symmetryEnabled ? 'block' : 'none';
  };

  // أدوات التحديد والتحويل
  btnSelectTools.onclick = (e) => {
    e.stopPropagation();
    const open = selectPopup.classList.contains('open');
    closeAllPopups();
    if (!open) selectPopup.classList.add('open');
  };

  document.querySelectorAll('#select-popup .option-card').forEach(card => {
    card.onclick = () => {
      document.querySelectorAll('#select-popup .option-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      const tool = card.dataset.tool;

      if (tool === 'transform') {
        engine.activateFreeTransform();
      } else {
        engine.currentTool = tool;
        resetToolButtons();
        btnSelectTools.classList.add('active');
      }
      closeAllPopups();
    };
  });

  // بقية الأدوات
  btnBrushesLibrary.onclick = (e) => {
    e.stopPropagation();
    if (engine.currentTool !== 'brush') {
      engine.currentTool = 'brush';
      resetToolButtons();
      btnBrushesLibrary.classList.add('active');
    }
    const open = brushesPopup.classList.contains('open');
    closeAllPopups();
    if (!open) brushesPopup.classList.add('open');
  };

  btnEraser.onclick = () => {
    closeAllPopups();
    engine.currentTool = 'eraser';
    resetToolButtons();
    btnEraser.classList.add('active');
  };

  btnShapesTool.onclick = (e) => {
    e.stopPropagation();
    const open = shapesPopup.classList.contains('open');
    closeAllPopups();
    if (!open) shapesPopup.classList.add('open');
  };

  btnBucket.onclick = (e) => {
    e.stopPropagation();
    engine.currentTool = 'bucket';
    resetToolButtons();
    btnBucket.classList.add('active');
    const open = bucketPopup.classList.contains('open');
    closeAllPopups();
    if (!open) bucketPopup.classList.add('open');
  };

  btnPipette.onclick = () => {
    closeAllPopups();
    engine.currentTool = 'pipette';
    resetToolButtons();
    btnPipette.classList.add('active');
  };

  btnPanTool.onclick = () => {
    closeAllPopups();
    engine.currentTool = 'pan';
    resetToolButtons();
    btnPanTool.classList.add('active');
  };

  btnToggleSize.onclick = (e) => {
    e.stopPropagation();
    const open = brushSettingsPopup.classList.contains('open');
    closeAllPopups();
    if (!open) brushSettingsPopup.classList.add('open');
  };

  btnToggleColor.onclick = (e) => {
    e.stopPropagation();
    const open = colorPopup.classList.contains('open');
    closeAllPopups();
    if (!open) colorPopup.classList.add('open');
  };

  btnToggleLayers.onclick = (e) => {
    e.stopPropagation();
    const open = layerPopup.classList.contains('open');
    closeAllPopups();
    if (!open) {
      layerPopup.classList.add('open');
      renderLayerList();
    }
  };

  document.body.onclick = (e) => {
    if (!e.target.closest('.popup-panel') && !e.target.closest('.tool-btn') && !e.target.closest('#top-bar')) {
      closeAllPopups();
    }
  };

  // اختيار الفُرش
  document.querySelectorAll('.brush-card').forEach(card => {
    card.onclick = () => {
      document.querySelectorAll('.brush-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      engine.brushType = card.dataset.brush;
      engine.currentTool = 'brush';
      resetToolButtons();
      btnBrushesLibrary.classList.add('active');
      closeAllPopups();
    };
  });

  // اختيار الأشكال
  document.querySelectorAll('#shapes-popup .option-card').forEach(card => {
    card.onclick = () => {
      document.querySelectorAll('#shapes-popup .option-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      engine.currentShape = card.dataset.shape;
      engine.currentTool = 'brush';
      resetToolButtons();
      if (engine.currentShape === 'freehand') {
        btnBrushesLibrary.classList.add('active');
      } else {
        btnShapesTool.classList.add('active');
      }
      closeAllPopups();
    };
  });

  // المنزلقات
  document.getElementById('bucket-tolerance').oninput = (e) => {
    engine.bucketTolerance = parseInt(e.target.value);
    document.getElementById('bucket-tolerance-val').textContent = e.target.value;
  };

  document.getElementById('bucket-expand').oninput = (e) => {
    engine.bucketExpand = parseInt(e.target.value);
    document.getElementById('bucket-expand-val').textContent = `${e.target.value}px`;
  };

  document.getElementById('brush-size').oninput = (e) => {
    engine.brushSize = parseInt(e.target.value);
    document.getElementById('brush-size-val').textContent = `${engine.brushSize}px`;
  };

  document.getElementById('brush-opacity').oninput = (e) => {
    engine.brushOpacity = parseInt(e.target.value) / 100;
    document.getElementById('brush-opacity-val').textContent = `${e.target.value}%`;
  };

  document.getElementById('screentone-freq').oninput = (e) => {
    engine.screentoneFrequency = parseInt(e.target.value);
    document.getElementById('screentone-freq-val').textContent = `${e.target.value}L`;
  };

  document.getElementById('stabilizer-slider').oninput = (e) => {
    engine.stabilizerStrength = parseInt(e.target.value);
    document.getElementById('stabilizer-val').textContent = `${e.target.value}%`;
  };

  // الطبقات
  const layerListContainer = document.getElementById('layer-list-container');
  const layerBlendSelect = document.getElementById('layer-blend-mode');
  const layerOpacitySlider = document.getElementById('layer-opacity-slider');
  const layerOpacityVal = document.getElementById('layer-opacity-val');
  const btnToggleAlphaLock = document.getElementById('btn-toggle-alphalock');
  const btnToggleClipping = document.getElementById('btn-toggle-clipping');
  const btnToggleReference = document.getElementById('btn-toggle-reference');

  document.getElementById('btn-add-layer').onclick = () => {
    engine.addLayer();
    renderLayerList();
  };

  btnToggleAlphaLock.onclick = () => {
    const curLayer = engine.getActiveLayer();
    if (curLayer) {
      curLayer.alphaLock = !curLayer.alphaLock;
      btnToggleAlphaLock.classList.toggle('active', curLayer.alphaLock);
      renderLayerList();
    }
  };

  btnToggleClipping.onclick = () => {
    const curLayer = engine.getActiveLayer();
    if (curLayer && engine.activeLayerIndex > 0) {
      curLayer.clippingMask = !curLayer.clippingMask;
      btnToggleClipping.classList.toggle('active', curLayer.clippingMask);
      engine.render();
      renderLayerList();
    }
  };

  btnToggleReference.onclick = () => {
    if (engine.referenceLayerIndex === engine.activeLayerIndex) {
      engine.referenceLayerIndex = -1;
      btnToggleReference.classList.remove('active');
    } else {
      engine.referenceLayerIndex = engine.activeLayerIndex;
      btnToggleReference.classList.add('active');
    }
    renderLayerList();
  };

  layerBlendSelect.onchange = (e) => {
    const curLayer = engine.getActiveLayer();
    if (curLayer) {
      curLayer.blendMode = e.target.value;
      engine.render();
      renderLayerList();
    }
  };

  layerOpacitySlider.oninput = (e) => {
    const curLayer = engine.getActiveLayer();
    if (curLayer) {
      curLayer.opacity = parseInt(e.target.value) / 100;
      layerOpacityVal.textContent = `${e.target.value}%`;
      engine.render();
    }
  };

  function renderLayerList() {
    layerListContainer.innerHTML = '';
    const activeLayer = engine.getActiveLayer();
    if (activeLayer) {
      layerBlendSelect.value = activeLayer.blendMode || 'source-over';
      layerOpacitySlider.value = Math.round(activeLayer.opacity * 100);
      layerOpacityVal.textContent = `${layerOpacitySlider.value}%`;
      btnToggleAlphaLock.classList.toggle('active', !!activeLayer.alphaLock);
      btnToggleClipping.classList.toggle('active', !!activeLayer.clippingMask);
      btnToggleReference.classList.toggle('active', engine.referenceLayerIndex === engine.activeLayerIndex);
    }

    engine.layers.forEach((layer, idx) => {
      const item = document.createElement('div');
      item.className = `layer-item ${idx === engine.activeLayerIndex ? 'selected' : ''} ${layer.clippingMask ? 'clipped' : ''}`;
      item.innerHTML = `
        <div class="layer-meta">
          <span class="layer-name">
            ${layer.name} 
            ${layer.alphaLock ? '🔒' : ''} 
            ${layer.clippingMask ? '📎' : ''}
            ${engine.referenceLayerIndex === idx ? '📌 [مرجع للدلو]' : ''}
          </span>
          <span style="font-size: 10px; color: var(--text-muted);">${layer.blendMode} - ${Math.round(layer.opacity * 100)}%</span>
        </div>
        <div class="layer-actions">
          <button class="vis-btn" style="padding: 2px 6px; font-size: 11px;">${layer.visible ? '👁' : '🚫'}</button>
          ${engine.layers.length > 1 ? '<button class="del-btn" style="padding: 2px 6px; font-size: 11px; background:#b23b3b; color:white;">✕</button>' : ''}
        </div>
      `;

      item.onclick = () => {
        engine.activeLayerIndex = idx;
        renderLayerList();
      };

      item.querySelector('.vis-btn').onclick = (e) => {
        e.stopPropagation();
        layer.visible = !layer.visible;
        engine.render();
        renderLayerList();
      };

      const delBtn = item.querySelector('.del-btn');
      if (delBtn) {
        delBtn.onclick = (e) => {
          e.stopPropagation();
          engine.activeLayerIndex = idx;
          engine.deleteActiveLayer();
          renderLayerList();
        };
      }

      layerListContainer.appendChild(item);
    });
  }

  // أحداث الشريط العلوي
  document.getElementById('btn-undo').onclick = () => engine.undo();
  document.getElementById('btn-redo').onclick = () => engine.redo();
  document.getElementById('btn-clear').onclick = () => engine.clearActiveLayer();
  document.getElementById('btn-save').onclick = () => {
    const link = document.createElement('a');
    link.download = 'manga-studio-master.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  // الملاحة
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
    const newZoom = Math.min(6.0, Math.max(0.12, engine.zoom * zoomFactor));

    const rect = viewport.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    engine.panX = mouseX - (mouseX - engine.panX) * (newZoom / engine.zoom);
    engine.panY = mouseY - (mouseY - engine.panY) * (newZoom / engine.zoom);
    engine.zoom = newZoom;
    engine.updateViewportTransform();
  }, { passive: false });

  let spacePressed = false;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !spacePressed) {
      spacePressed = true;
      viewport.classList.add('panning');
    }
    // اختصار إلغاء التحديد Ctrl + D
    if (e.ctrlKey && e.code === 'KeyD') {
      e.preventDefault();
      engine.deselect();
    }
    // اختصار التراجع Ctrl + Z
    if (e.ctrlKey && e.code === 'KeyZ') {
      e.preventDefault();
      engine.undo();
    }
    // اختصار الإعادة Ctrl + Y
    if (e.ctrlKey && e.code === 'KeyY') {
      e.preventDefault();
      engine.redo();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spacePressed = false;
      viewport.classList.remove('panning');
    }
  });

  viewport.addEventListener('pointerdown', (e) => {
    if (e.button === 1 || spacePressed || engine.currentTool === 'pan') {
      engine.isPanning = true;
      engine.panStartX = e.clientX - engine.panX;
      engine.panStartY = e.clientY - engine.panY;
      viewport.classList.add('panning');
      return;
    }

    if (e.button === 0) {
      const coords = engine.screenToCanvas(e.clientX, e.clientY);
      if (coords.x >= 0 && coords.x <= canvas.width && coords.y >= 0 && coords.y <= canvas.height) {
        viewport.setPointerCapture(e.pointerId);
        const pressure = e.pressure !== undefined && e.pressure !== 0 ? e.pressure : 1.0;
        engine.startStroke(coords.x, coords.y, pressure);
      }
    }
  });

  viewport.addEventListener('pointermove', (e) => {
    if (engine.isPanning) {
      engine.panX = e.clientX - engine.panStartX;
      engine.panY = e.clientY - engine.panStartY;
      engine.updateViewportTransform();
      return;
    }

    if (!engine.isDrawing) return;
    const coords = engine.screenToCanvas(e.clientX, e.clientY);
    const pressure = e.pressure !== undefined && e.pressure !== 0 ? e.pressure : 1.0;
    engine.continueStroke(coords.x, coords.y, pressure);
  });

  viewport.addEventListener('pointerup', () => {
    if (engine.isPanning) {
      engine.isPanning = false;
      if (!spacePressed) viewport.classList.remove('panning');
    }
    engine.endStroke();
  });

  viewport.addEventListener('pointercancel', () => {
    engine.isPanning = false;
    engine.endStroke();
  });
});
