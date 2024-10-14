const express = require('express');
const router = express.Router();
const Authorize = require('../models/Authorize');
const Property = require('../models/Property'); // Property model
const Unit = require('../models/Unit'); // Unit model
const Tenant = require('../models/Tenant'); // Tenant model

// Middleware to check user authorization and render the appropriate form
router.get('/checkAuthorization/:id', async (req, res) => {
    const id = req.params.id;
    const action = req.query.action; // action: 'addproperty', 'addunit', 'addtenant'

    try {
        // Find the authorization record
        const authorizeRecord = await Authorize.findById(id);
        if (!authorizeRecord) {
            return res.status(404).send('Authorization record not found.');
        }

        const phoneNumber = authorizeRecord.phoneNumber;

        // Wait for the user's response logic (replace with your actual wait logic)
        const waitForUserResponse = async (phoneNumber) => {
            return new Promise((resolve) => {
                setTimeout(() => resolve('yes_authorize'), 1000);  // Simulate user response
            });
        };

        // Check if the user response was 'Yes_authorize'
        const userResponse = await waitForUserResponse(phoneNumber);
        if (userResponse && userResponse.toLowerCase() === 'yes_authorize') {
            console.log("User authorized the action.");

            // Check the action type and render the corresponding form
            if (action === 'addproperty') {
                res.send(`
                    <html>
                    <head>
                        <link rel="stylesheet" type="text/css" href="/styles.css">
                    </head>
                    <body>
                        <div class="container">
                            <h2>Authorization successful! Add your property below:</h2>
                            <form action="/properties/addproperty/${id}" method="POST" enctype="multipart/form-data">
                                <label for="property_name">Property Name:</label>
                                <input type="text" id="property_name" name="property_name" required><br><br>

                                <label for="units">Number of Units:</label>
                                <input type="number" id="units" name="units" required><br><br>

                                <label for="address">Address:</label>
                                <input type="text" id="address" name="address" required><br><br>

                                <label for="totalAmount">Total Amount:</label>
                                <input type="number" id="totalAmount" name="totalAmount" required><br><br>

                                <label for="image">Property Image:</label>
                                <input type="file" id="image" name="image" required><br><br>

                                <button type="submit">Submit</button>
                            </form>
                        </div>
                    </body>
                    </html>
                `);
            } else if (action === 'addunit') {
                const properties = await Property.find().select('name _id');
                res.send(`
                    <html>
                    <head>
                        <link rel="stylesheet" type="text/css" href="/styles.css">
                    </head>
                    <body>
                        <div class="container">
                            <h2>Authorization successful! Add your unit below:</h2>
                            <form action="/units/addunit/${id}" method="POST" enctype="multipart/form-data">
                                <label for="property">Property:</label>
                                <select id="property" name="property" required>
                                    ${properties.map(property => `<option value="${property._id}">${property.name}</option>`).join('')}
                                </select><br><br>

                                <label for="unit_number">Unit Number:</label>
                                <input type="text" id="unit_number" name="unit_number" required><br><br>

                                <label for="rent_amount">Rent Amount:</label>
                                <input type="number" id="rent_amount" name="rent_amount" required><br><br>

                                <label for="floor">Floor:</label>
                                <input type="number" id="floor" name="floor" required><br><br>

                                <label for="size">Size (sqft):</label>
                                <input type="number" id="size" name="size" required><br><br>

                                <label for="image">Unit Image:</label>
                                <input type="file" id="image" name="image" required><br><br>

                                <button type="submit">Submit</button>
                            </form>
                        </div>
                    </body>
                    </html>
                `);
            } else if (action === 'addtenant') {
                const properties = await Property.find().select('name _id');
                res.send(`
                    <html>
                    <head>
                        <link rel="stylesheet" type="text/css" href="/styles.css">
                        <script>
                            async function fetchUnits(propertyId) {
                                const response = await fetch('/units/getUnits/' + propertyId);
                                const units = await response.json();
                                const unitDropdown = document.getElementById('unitAssigned');
                                unitDropdown.innerHTML = '';
                                units.forEach(unit => {
                                    const option = document.createElement('option');
                                    option.value = unit._id;
                                    option.text = unit.unitNumber;
                                    unitDropdown.appendChild(option);
                                });
                            }
                        </script>
                    </head>
                    <body>
                        <div class="container">
                            <h2>Authorization successful! Add your tenant below:</h2>
                            <form action="/tenants/addtenant/${id}" method="POST" enctype="multipart/form-data">
                                <label for="name">Tenant Name:</label>
                                <input type="text" id="name" name="name" required><br><br>

                                <label for="phoneNumber">Phone Number:</label>
                                <input type="text" id="phoneNumber" name="phoneNumber" required><br><br>

                                <label for="propertyName">Property:</label>
                                <select id="propertyName" name="propertyName" required onchange="fetchUnits(this.value)">
                                    ${properties.map(property => `<option value="${property._id}">${property.name}</option>`).join('')}
                                </select><br><br>

                                <label for="unitAssigned">Unit Assigned:</label>
                                <select id="unitAssigned" name="unitAssigned" required>
                                    <option value="">Select a property first</option>
                                </select><br><br>

                                <label for="lease_start">Lease Start Date:</label>
                                <input type="date" id="lease_start" name="lease_start" required><br><br>

                                <label for="deposit">Deposit Amount:</label>
                                <input type="number" id="deposit" name="deposit" required><br><br>

                                <label for="idProof">ID Proof (Image):</label>
                                <input type="file" id="idProof" name="idProof" required><br><br>

                                <label for="photo">Photo (Image):</label>
                                <input type="file" id="photo" name="photo" required><br><br>

                                <button type="submit">Submit</button>
                            </form>
                        </div>
                    </body>
                    </html>
                `);
            }
        } else {
            return res.json({ status: 'waiting' });
        }
    } catch (error) {
        res.status(500).send('An error occurred while checking authorization.');
    }
});

module.exports = router;
