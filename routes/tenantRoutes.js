const express = require('express');
const router = express.Router();
const multer = require('multer');
const Tenant = require('../models/Tenant');
const Image = require('../models/Image');
const { sendWhatsAppAuthMessage } = require('../utils/whatsapp');

// Multer setup for image uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// Route to add a tenant
router.get('/addtenant/:id', async (req, res) => {
    const id = req.params.id;
    try {
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).send('Authorization record not found.');
        }
        const phoneNumber = authorizeRecord.phoneNumber;

        // Send WhatsApp authorization message
        await sendWhatsAppAuthMessage(phoneNumber);

        res.send(`
            <html>
            <!-- Tenant form HTML code here -->
            </html>
        `);
    } catch (error) {
        res.status(500).send('An error occurred during authorization.');
    }
});

// POST route for submitting the tenant form
router.post('/addtenant/:id', upload.fields([{ name: 'idProof', maxCount: 1 }, { name: 'photo', maxCount: 1 }]), async (req, res) => {
    const { name, phoneNumber, propertyName, unitAssigned, lease_start, deposit } = req.body;

    try {
        const tenant = new Tenant({
            name,
            phoneNumber,
            propertyName,
            unitAssigned,
            lease_start,
            deposit,
            status: 'unpaid',
        });

        if (req.files['idProof']) {
            const idProofImage = new Image({
                tenantId: tenant._id,
                imageUrl: '/uploads/' + req.files['idProof'][0].filename,
                imageName: req.files['idProof'][0].originalname,
            });
            await idProofImage.save();
            tenant.idProof = idProofImage.imageUrl;
        }

        if (req.files['photo']) {
            const photoImage = new Image({
                tenantId: tenant._id,
                imageUrl: '/uploads/' + req.files['photo'][0].filename,
                imageName: req.files['photo'][0].originalname,
            });
            await photoImage.save();
            tenant.photo = photoImage.imageUrl;
        }

        await tenant.save();
        res.send('Tenant and images added successfully!');
    } catch (error) {
        res.status(500).send('An error occurred while adding the tenant and images.');
    }
});

module.exports = router;
