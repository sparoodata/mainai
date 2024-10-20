const fs = require('fs');
const { google } = require('googleapis');
const path = require('path');

// Path to your credentials and token files
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');

// Function to authenticate with Google Drive
async function authenticate() {
    // Load the OAuth2 client credentials from credentials.json
    const content = fs.readFileSync(CREDENTIALS_PATH);
    const credentials = JSON.parse(content);

    // Destructure client details from credentials
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;

    if (!redirect_uris || redirect_uris.length === 0) {
        throw new Error("No redirect URIs found in credentials.json");
    }

    // Create a new OAuth2 client
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    // Check if token.json exists and is valid
    if (fs.existsSync(TOKEN_PATH)) {
        try {
            const token = fs.readFileSync(TOKEN_PATH, 'utf-8');
            if (!token) {
                // If the token file is empty, get a new token
                await getAccessToken(oAuth2Client);
            } else {
                // Try parsing the token
                const parsedToken = JSON.parse(token);
                oAuth2Client.setCredentials(parsedToken);

                // Check if the access token is expired, if so, refresh it
                if (isTokenExpired(parsedToken)) {
                    console.log("Access token expired, refreshing...");
                    await refreshAccessToken(oAuth2Client);
                } else {
                    console.log("Using existing token");
                }
            }
        } catch (error) {
            console.error("Error reading or parsing token.json:", error.message);
            // If there's any error reading or parsing the token, get a new one
            await getAccessToken(oAuth2Client);
        }
    } else {
        // If token.json doesn't exist, prompt for a new token
        await getAccessToken(oAuth2Client);
    }

    return oAuth2Client;
}

// Function to get a new access token and store it in token.json
function getAccessToken(oAuth2Client) {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline', // Allows for refresh tokens
        scope: ['https://www.googleapis.com/auth/drive.file'], // Scopes for Drive API
    });
    console.log('Authorize this app by visiting this URL:', authUrl);

    // Create a readline interface to receive the authorization code from the user
    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve, reject) => {
        // Prompt the user to enter the authorization code from the consent screen
        rl.question('Enter the code from that page here: ', (code) => {
            rl.close();
            // Exchange the code for an access token
            oAuth2Client.getToken(code, (err, token) => {
                if (err) {
                    console.error('Error retrieving access token:', err.message);
                    return reject(err); // Add better error handling here
                }
                console.log('Token received:', token); // Log the received token
                
                // Set the credentials for the OAuth2 client
                oAuth2Client.setCredentials(token);

                // Now write the token to token.json
                try {
                    fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
                    console.log('Token stored to', TOKEN_PATH);
                    resolve(oAuth2Client);
                } catch (writeError) {
                    console.error('Error saving token to token.json:', writeError.message);
                    reject(writeError); // Handle token save failure
                }
            });
        });
    });
}

// Function to check if the access token is expired
function isTokenExpired(token) {
    const now = Date.now();
    return token.expiry_date && token.expiry_date <= now;
}

// Function to refresh the access token
async function refreshAccessToken(oAuth2Client) {
    try {
        const newTokens = await oAuth2Client.refreshAccessToken();
        const token = newTokens.credentials;
        
        // Save the new token to token.json
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
        console.log('Refreshed and saved new token');
    } catch (error) {
        console.error('Error refreshing access token:', error.message);
    }
}

module.exports = { authenticate };
