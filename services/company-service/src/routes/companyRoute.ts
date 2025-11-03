// This route is strictly for the companies to register itself in the system. They will be able to register themselves by providing their name, email, address, phone, website, logo, description, category, and sub-category as defined in the Company model.
import { Router } from 'express';
import { Request, Response } from 'express';
import { Company } from '../models/Company';
import jwt, { JwtPayload } from 'jsonwebtoken';
const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ message: 'Company Service is running', service: 'company-service' });
});

// Middleware to verify JWT token
export const verifyToken = (req: Request, res: Response, next: any) => {
  try {
    const token = req.headers.authorization?.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        message: 'Access denied',
        error: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    req.body.adminId = decoded.adminId;
    req.body.adminEmail = decoded.adminEmail;
    req.body.adminName = decoded.adminName;
    next();
  } catch (error) {
    return res.status(401).json({
      message: 'Invalid token',
      error: 'Token verification failed'
    });
  }
};

// ✅ Working perfectly
// Register company endpoint (to register a new company)
// The required API key to register a company will be that of the Connect Fulfillment company.
router.post('/register', async (req: Request, res: Response) => {
  try {
    if (!req.body.companyName || !req.body.companyEmail || !req.body.companyAddress || !req.body.companyPhone || !req.body.companyWebsite || !req.body.companyLogo || !req.body.companyDescription || !req.body.companyDetails || !req.body.companyCategory || !req.body.companySubCategory) {
      return res.status(400).json({
        message: 'All fields are required',
        errors: {
          companyName: !req.body.companyName ? 'Company name is required' : null,
          companyEmail: !req.body.companyEmail ? 'Company email is required' : null,
          companyAddress: !req.body.companyAddress ? 'Company address is required' : null,
          companyPhone: !req.body.companyPhone ? 'Company phone is required' : null,
          companyWebsite: !req.body.companyWebsite ? 'Company website is required' : null,
          companyLogo: !req.body.companyLogo ? 'Company logo is required' : null,
          companyDescription: !req.body.companyDescription ? 'Company description is required' : null,
          companyDetails: !req.body.companyDetails ? 'Company details are required' : null,
          companyCategory: !req.body.companyCategory ? 'Company category is required' : null,
          companySubCategory: !req.body.companySubCategory ? 'Company sub-category is required' : null
        }
      });
    }
    const { companyName, companyEmail, companyAddress, companyPhone, companyWebsite, companyLogo, companyDescription, companyDetails, companyCategory, companySubCategory, companyApiKey, isVerified } = req.body;
    const company = await Company.create({ companyName, companyEmail, companyAddress, companyPhone, companyWebsite, companyLogo, companyDescription, companyDetails, companyCategory, companySubCategory, companyApiKey, isVerified });
    res.status(201).json({ message: 'Company registered successfully', company });
  } catch (error: any) {
    res.status(500).json({ message: 'Internal server error', error: error?.message || 'An unknown error occurred' });
  }
})

// ✅ Working perfectly
// Get all companies endpoint (to get all companies - Only Connect Fulfillment Admins can access this route)
router.get('/companies', verifyToken, async (_req: Request, res: Response) => {
  // if (!req.body.company) return res.status(401).json({ message: 'Unauthorized' });
  const companyNames = await Company.find({}, 'companyName');
  res.status(200).json({ companyNames });
});

//  ✅Working perfectly
// Verifies if API key is valid or not
router.get('/verify-key', async (req: Request, res: Response) => {
  const apiKey = req.headers['your_company_api_key'] as string;
  if (!apiKey) return res.json({ valid: false, error: 'API key validation failed: Company API key is required' });

  const companyExist = await Company.findOne({ companyApiKey: apiKey });
  if (!companyExist) return res.json({ valid: false, error: 'API key validation failed: Invalid Company API key' });
  console.log('Company exists:', companyExist);
    res.json({ valid: true, company: companyExist });
  });
export default router;

// {
//   "companyName": "Ace Supermarket",
//   "companyEmail": "ace@supermarket.com",
//   "companyAddress": "123 Ace St, Ace City, Ace Country",
//   "companyPhone": 2345678901,
//   "companyWebsite": "https://ace.com",
//   "companyLogo": "https://ace.com/logo.png",
//   "companyDescription": "Ace Supermarket is a grocery store that sells a wide variety of products.",
//   "companyDetails": "Ace Supermarket is a grocery store that sells a wide variety of products. It is located in the heart of the city and has a wide variety of products to offer. We have a minimum of 100 products to offer and we have customers from all over the city.",
//   "companyCategory": "Other",
//   "companySubCategory": "Other",
// }