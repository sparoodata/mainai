const express = require('express');
const router = express.Router();
const Property = require('../models/Property');
const Tenant = require('../models/Tenant');

// Dashboard main page
router.get('/', async (req, res) => {
    try {
        const properties = await Property.find({});
        const tenants = await Tenant.find({});
        res.json({ properties, tenants });
    } catch (error) {
        res.status(500).send('Error fetching dashboard data.');
    }
});

// Mark tenant as paid
router.post('/tenant/:id/markAsPaid', async (req, res) => {
    try {
        const tenant = await Tenant.findById(req.params.id);
        tenant.status = 'PAID';
        await tenant.save();
        res.json({ success: true });
    } catch (error) {
        res.status(500).send('Error updating tenant status.');
    }
});

module.exports = router;
