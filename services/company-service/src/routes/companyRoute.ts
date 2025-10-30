// This route is strictly for the companies to register itself in the system. They will be able to register themselves by providing their name, email, address, phone, website, logo, description, category, and sub-category as defined in the Company model.
import { Router } from 'express';
import { Request, Response } from 'express';
import { Company } from '../models/Company';
const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ message: 'Company Service is running', service: 'company-service' });
});

router.post('/register', async (req: Request, res: Response) => {
  try {
    const { companyName, companyEmail, companyAddress, companyPhone, companyWebsite, companyLogo, companyDescription, companyCategory, companySubCategory } = req.body;
    const company = await Company.create({ companyName, companyEmail, companyAddress, companyPhone, companyWebsite, companyLogo, companyDescription, companyCategory, companySubCategory });
    res.status(201).json({ message: 'Company registered successfully', company });
  } catch (error: any) {
    res.status(500).json({ message: 'Internal server error', error: error?.message || 'An unknown error occurred' });
  }
})

router.get('/companies', async (req: Request, res: Response) => {
  // if (!req.body.company) return res.status(401).json({ message: 'Unauthorized' });
  const companies = await Company.find();
  res.status(200).json({ companies });
});

router.get('/verify-key', async (req: Request, res: Response) => {
  const apiKey = req.headers['your_company_api_key'] as string;
  if (!apiKey) return res.json({ valid: false });

  // Fake API key from the environment variable for testing purposes
  const fakeApiKey = process.env.FAKE_API_KEY as string;
  if (apiKey === fakeApiKey) return res.json({ valid: true, company: { companyName: 'Test Company', companyEmail: 'test@test.com', companyAddress: '123 Test St, Test City, Test Country', companyPhone: 1234567890, companyWebsite: 'https://test.com', companyLogo: 'https://test.com/logo.png', companyDescription: 'Test Description', companyCategory: 'Test Category', companySubCategory: 'Test SubCategory', companyApiKey: fakeApiKey } });

  // Real API key from the database
  // const company = await Company.findOne({ companyApiKey: apiKey });
  // if (!company) return res.json({ valid: false });

  // res.json({ valid: true, company });
});

export default router;