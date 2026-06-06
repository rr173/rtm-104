const express = require('express');
const router = express.Router();
const recipeService = require('../services/recipeService');

router.post('/', async (req, res) => {
  try {
    const result = await recipeService.createRecipe(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.status(201).json(result.recipe);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const recipes = await recipeService.getAllRecipes();
    res.json(recipes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const recipe = await recipeService.getRecipeById(req.params.id);
    if (!recipe) {
      return res.status(404).json({ error: '配方不存在' });
    }
    res.json(recipe);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const result = await recipeService.updateRecipe(req.params.id, req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result.recipe);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const success = await recipeService.deleteRecipe(req.params.id);
    if (!success) {
      return res.status(404).json({ error: '配方不存在' });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/apply', async (req, res) => {
  try {
    const result = await recipeService.applyRecipe(req.params.id);
    if (!result.success) {
      const code = result.phase === 'validate' ? 400 : 500;
      return res.status(code).json({
        error: result.error,
        failedItem: result.failedItem,
        rolledBack: result.rolledBack
      });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/validate', async (req, res) => {
  try {
    const result = await recipeService.validateRecipe(req.params.id);
    if (!result.success) {
      return res.status(404).json({ error: result.error });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
