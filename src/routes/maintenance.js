const express = require('express');
const router = express.Router();
const maintenanceService = require('../services/maintenanceService');

router.post('/orders', async (req, res) => {
  try {
    const result = await maintenanceService.createOrder(req.body);
    if (!result.success) {
      return res.status(result.code || 400).json({ error: result.error });
    }
    res.status(201).json(result.order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/orders', async (req, res) => {
  try {
    const { status, deviceId, maintenanceType } = req.query;
    const orders = await maintenanceService.listOrders({
      status,
      deviceId,
      maintenanceType
    });
    res.json(orders);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const { deviceId, startDate, endDate } = req.query;
    const stats = await maintenanceService.getStats({
      deviceId,
      startDate: startDate ? parseInt(startDate) : null,
      endDate: endDate ? parseInt(endDate) : null
    });
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/events', async (req, res) => {
  try {
    const { orderId, limit } = req.query;
    const events = await maintenanceService.getEvents(orderId, limit);
    res.json(events);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/orders/:id', async (req, res) => {
  try {
    const order = await maintenanceService.getOrderById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: '工单不存在' });
    }
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/orders/:id/start', async (req, res) => {
  try {
    const result = await maintenanceService.startOrder(req.params.id);
    if (!result.success) {
      return res.status(result.code || 400).json({ error: result.error });
    }
    res.json(result.order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/orders/:id/complete', async (req, res) => {
  try {
    const result = await maintenanceService.completeOrder(req.params.id);
    if (!result.success) {
      return res.status(result.code || 400).json({ error: result.error });
    }
    res.json(result.order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/orders/:id/cancel', async (req, res) => {
  try {
    const result = await maintenanceService.cancelOrder(req.params.id);
    if (!result.success) {
      return res.status(result.code || 400).json({ error: result.error });
    }
    res.json(result.order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
