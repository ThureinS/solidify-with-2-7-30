const express = require('express');
const validate = require('../middleware/validate');
const requireAuth = require('../middleware/auth');
const controller = require('../controllers/items.controller');
const {
  createItemSchema,
  updateItemSchema,
  listItemsQuerySchema,
} = require('../dto/item.schemas');
const { reviewActionSchema, dueQuerySchema } = require('../dto/review.schemas');

const router = express.Router();

router.use(requireAuth);

router.post('/', validate(createItemSchema), controller.createItem);
router.get('/', validate(listItemsQuerySchema, 'query'), controller.listItems);

// Must come before '/:id' -- otherwise Express would match "due" as an :id.
router.get('/due', validate(dueQuerySchema, 'query'), controller.listDue);

router.get('/:id', controller.getItem);
router.patch('/:id', validate(updateItemSchema), controller.updateItem);
router.delete('/:id', controller.deleteItem);
router.post('/:id/review', validate(reviewActionSchema), controller.reviewItem);
router.post('/:id/skip', validate(reviewActionSchema), controller.skipItem);

module.exports = router;
