const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const mongoose = require('mongoose');

// Models
const Property = require('../models/Property');
const Unit = require('../models/Unit');
const Tenant = require('../models/Tenant');
const User = require('../models/User');

// Utils
const helpers = require('../utils/helpers');
const groqAI = require('../utils/groqAI');
const zepMemory = require('../utils/zepMemory');

// Property routes
router.post('/property', async (req, res) => {
  try {
    const { name, address, type, size, owner } = req.body;
    
    const property = new Property({
      name,
      address,
      type,
      size,
      owner: mongoose.Types.ObjectId(owner)
    });
    
    await property.save();
    
    res.status(201).json(property);
  } catch (error) {
    console.error('Error creating property:', error);
    res.status(500).json(helpers.formatError(error, 'create_property'));
  }
});

router.get('/property', async (req, res) => {
  try {
    const { owner } = req.query;
    
    const query = owner ? { owner: mongoose.Types.ObjectId(owner) } : {};
    const properties = await Property.find(query).sort({ createdAt: -1 });
    
    res.json(properties);
  } catch (error) {
    console.error('Error fetching properties:', error);
    res.status(500).json(helpers.formatError(error, 'fetch_properties'));
  }
});

router.get('/property/:id', async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    
    if (!property) {
      return res.status(404).json({ error: 'Property not found' });
    }
    
    res.json(property);
  } catch (error) {
    console.error('Error fetching property:', error);
    res.status(500).json(helpers.formatError(error, 'fetch_property'));
  }
});

// Unit routes
router.post('/unit', async (req, res) => {
  try {
    const { property, floor, rent, isAvailable } = req.body;
    
    // Generate unique unitId
    const unitId = helpers.generateUnitId();
    
    const unit = new Unit({
      unitId,
      property: mongoose.Types.ObjectId(property),
      floor,
      rent,
      isAvailable
    });
    
    await unit.save();
    
    res.status(201).json(unit);
  } catch (error) {
    console.error('Error creating unit:', error);
    res.status(500).json(helpers.formatError(error, 'create_unit'));
  }
});

router.get('/unit', async (req, res) => {
  try {
    const { property } = req.query;
    
    const query = property ? { property: mongoose.Types.ObjectId(property) } : {};
    const units = await Unit.find(query).sort({ createdAt: -1 });
    
    res.json(units);
  } catch (error) {
    console.error('Error fetching units:', error);
    res.status(500).json(helpers.formatError(error, 'fetch_units'));
  }
});

router.get('/unit/:id', async (req, res) => {
  try {
    const unit = await Unit.findById(req.params.id).populate('property');
    
    if (!unit) {
      return res.status(404).json({ error: 'Unit not found' });
    }
    
    res.json(unit);
  } catch (error) {
    console.error('Error fetching unit:', error);
    res.status(500).json(helpers.formatError(error, 'fetch_unit'));
  }
});

// Tenant routes
router.post('/tenant', async (req, res) => {
  try {
    const { name, contact, unit, moveInDate, rentInfo } = req.body;
    
    // Generate unique tenantId
    const tenantId = helpers.generateTenantId();
    
    const tenant = new Tenant({
      tenantId,
      name,
      contact,
      unit: mongoose.Types.ObjectId(unit),
      moveInDate,
      rentInfo
    });
    
    await tenant.save();
    
    // Update unit availability
    await Unit.findByIdAndUpdate(unit, { isAvailable: false });
    
    res.status(201).json(tenant);
  } catch (error) {
    console.error('Error creating tenant:', error);
    res.status(500).json(helpers.formatError(error, 'create_tenant'));
  }
});

router.get('/tenant', async (req, res) => {
  try {
    const { unit, property } = req.query;
    
    let query = {};
    
    if (unit) {
      query.unit = mongoose.Types.ObjectId(unit);
    } else if (property) {
      // Find all units for the property
      const units = await Unit.find({ property: mongoose.Types.ObjectId(property) });
      const unitIds = units.map(unit => unit._id);
      
      // Find tenants for these units
      query.unit = { $in: unitIds };
    }
    
    const tenants = await Tenant.find(query)
      .populate('unit')
      .sort({ createdAt: -1 });
    
    res.json(tenants);
  } catch (error) {
    console.error('Error fetching tenants:', error);
    res.status(500).json(helpers.formatError(error, 'fetch_tenants'));
  }
});

router.get('/tenant/:id', async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.params.id)
      .populate({
        path: 'unit',
        populate: {
          path: 'property'
        }
      });
    
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    
    res.json(tenant);
  } catch (error) {
    console.error('Error fetching tenant:', error);
    res.status(500).json(helpers.formatError(error, 'fetch_tenant'));
  }
});

// File upload routes
router.post('/upload/:type/:id', upload.single('file'), async (req, res) => {
  try {
    const { type, id } = req.params;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Validate type
    if (!['property', 'unit', 'tenant', 'document'].includes(type)) {
      return res.status(400).json({ error: 'Invalid upload type' });
    }
    
    // Upload file with thumbnail if it's an image
    const fileData = await helpers.uploadImageWithThumbnail(file, req.user._id, type);
    
    // Update the corresponding model with the file data
    let model;
    switch (type) {
      case 'property':
        model = await Property.findById(id);
        if (!model) return res.status(404).json({ error: 'Property not found' });
        model.images.push(fileData);
        break;
      case 'unit':
        model = await Unit.findById(id);
        if (!model) return res.status(404).json({ error: 'Unit not found' });
        model.images.push(fileData);
        break;
      case 'tenant':
        model = await Tenant.findById(id);
        if (!model) return res.status(404).json({ error: 'Tenant not found' });
        model.documents.push({
          ...fileData,
          type: req.body.documentType || 'Other'
        });
        break;
      default:
        return res.status(400).json({ error: 'Invalid upload type' });
    }
    
    await model.save();
    
    res.status(201).json(fileData);
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json(helpers.formatError(error, 'upload_file'));
  }
});

// Summary routes
router.get('/summary/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    let entityData;
    switch (type) {
      case 'property':
        entityData = await Property.findById(id);
        if (!entityData) return res.status(404).json({ error: 'Property not found' });
        break;
      case 'unit':
        entityData = await Unit.findById(id).populate('property');
        if (!entityData) return res.status(404).json({ error: 'Unit not found' });
        break;
      case 'tenant':
        entityData = await Tenant.findById(id).populate({
          path: 'unit',
          populate: {
            path: 'property'
          }
        });
        if (!entityData) return res.status(404).json({ error: 'Tenant not found' });
        break;
      default:
        return res.status(400).json({ error: 'Invalid summary type' });
    }
    
    // Generate summary with Groq AI
    const summary = await groqAI.generateEntitySummary(userId, type, entityData);
    
    res.json({ summary });
  } catch (error) {
    console.error('Error generating summary:', error);
    res.status(500).json(helpers.formatError(error, 'generate_summary'));
  }
});

module.exports = router;
