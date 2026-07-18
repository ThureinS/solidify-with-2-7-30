const express = require('express');
const validate = require('../middleware/validate');
const devUser = require('../middleware/devUser');
const controller = require('../controllers/items.controller');
const {
  createItemSchema,
  updateItemSchema,
  listItemsQuerySchema,
} = require('../dto/item.schemas');

const router = express.Router();

// TEMPORARY: replaced by real JWT auth middleware in Part 5.
router.use(devUser);

router.post('/', validate(createItemSchema), controller.createItem);
router.get('/', validate(listItemsQuerySchema, 'query'), controller.listItems);
router.get('/:id', controller.getItem);
router.patch('/:id', validate(updateItemSchema), controller.updateItem);
router.delete('/:id', controller.deleteItem);

module.exports = router;
