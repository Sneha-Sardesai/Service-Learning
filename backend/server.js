const express = require('express');
const { createCompanyResponse } = require('./researchService');

const app = express();
const port = 5000;

app.use(express.json());

app.get('/', (request, response) => {
  response.send('Backend is running');
});

// To receive company name from user and send company-related data
app.post('/api/research', (request, response) => {
  const { companyName } = request.body || {};

  if (!companyName) {
    return response.status(400).json({
      error: 'companyName is required',
    });
  }

  response.json(createCompanyResponse(companyName));
});

app.listen(port, () => {
  console.log(`Backend server listening on port ${port}`);
  console.log(`Starting server on http://localhost:5000/`)
});