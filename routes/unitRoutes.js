const express = require('express');
const router = express.Router();
const multer = require('multer');
const Unit = require('../models/Unit');
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

// Route to add a unit
router.get('/addunit/:id', async (req, res) => {
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
            <!-- Unit form HTML code here -->
            </html>
        `);
    } catch (error) {
        res.status(500).send('An error occurred during authorization.');
    }
});

// POST route for submitting the unit form
router.post('/addunit/:id', upload.single('image'), async (req, res) => {
    const { property, unit_number, rent_amount, floor, size } = req.body;

    try {
        const unit = new Unit({
            property,
            unitNumber: unit_number,
            rentAmount: rent_amount,
            floor,
            size,
        });

        await unit.save();

        if (req.file) {
            const image = new Image({
                unitId: unit._id,
                imageUrl: '/uploads/' + req.file.filename,
                imageName: req.file.originalname,
            });

            await image.save();

            unit.images.push(image._id);
            await unit.save();
        }

        res.send('Unit and image added successfully!');
    } catch (error) {
        res.status(500).send('An error occurred while adding the unit and image.');
    }
});

module.exports = router;
