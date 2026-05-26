import express from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // Gemini Setup
  const apiKey = process.env.GEMINI_API_KEY;
  const ai = apiKey ? new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  }) : null;

  // Endpoint to check environment configuration
  app.get('/api/config', (req, res) => {
    res.json({
      hasApiKey: !!process.env.GEMINI_API_KEY,
      appUrl: process.env.APP_URL || 'http://localhost:3000'
    });
  });

  // Server-side API Proxy Route for Gemini OCR
  app.post('/api/gemini/ocr', async (req, res) => {
    if (!ai) {
      console.error('[Gemini OCR Error] AI Client is not initialized. GEMINI_API_KEY is missing.');
      return res.status(500).json({ 
        error: 'GEMINI_API_KEY is not defined on the server side. Please ensure the API key is registered under Settings > Secrets.' 
      });
    }

    const { image } = req.body;
    
    if (!image) {
      return res.status(400).json({ error: 'Image data is required' });
    }

    try {
      let mimeType = 'image/jpeg';
      let base64Data = image;

      if (image.includes(';base64,')) {
        const parts = image.split(';base64,');
        base64Data = parts[1];
        const mimePart = parts[0];
        if (mimePart.startsWith('data:')) {
          mimeType = mimePart.substring(5);
        }
      }

      console.log(`[Gemini OCR] Processing image. MimeType: ${mimeType}, base64 length: ${base64Data.length}`);

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: mimeType,
                data: base64Data,
              },
            },
            {
              text: "Please perform OCR on this receipt image. Read and extract all the text verbatim, keeping its layout as close to the original as possible. Do not append any markdown wrappers, commentary, greetings, or codeblocks. Just return the raw extracted text of the receipt itself."
            }
          ]
        },
      });

      console.log(`[Gemini OCR] Successful generation. Response length: ${response?.text?.length || 0}`);
      res.json({ text: response.text });
    } catch (err: any) {
      console.error('[Gemini OCR Error] Failed:', err);
      res.status(500).json({ 
        error: err.message || 'An error occurred during OCR text extraction.' 
      });
    }
  });

  // Server-side API Proxy Route for Gemini
  app.post('/api/gemini/generate', async (req, res) => {
    if (!ai) {
      return res.status(500).json({ 
        error: 'GEMINI_API_KEY is not defined on the server side. Please ensure the API key is registered under Settings > Secrets.' 
      });
    }

    const { prompt, model, config } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    try {
      const targetModel = model || 'gemini-2.5-flash';
      
      // Smart normalizer to extract correct contents configuration
      let resolvedContents: any = prompt;
      if (prompt && typeof prompt === 'object') {
        if (prompt.contents) {
          resolvedContents = prompt.contents;
        } else if (prompt.parts) {
          resolvedContents = [prompt];
        }
      }

      // Highly robust content sanitizer to align with modern @google/genai Typescript structures
      // and strip empty/unused keys that trigger protobuf 'oneof' empty schema validation errors.
      if (Array.isArray(resolvedContents)) {
        resolvedContents = resolvedContents.map((content: any) => {
          if (!content || typeof content !== 'object') {
            return content;
          }
          const rawParts = content.parts || [];
          const sanitizedParts = rawParts.map((part: any) => {
            if (!part || typeof part !== 'object') {
              return part;
            }
            const cleanPart: any = {};
            if (typeof part.text === 'string') {
              cleanPart.text = part.text;
            } else if (part.inlineData && part.inlineData.data) {
              cleanPart.inlineData = {
                mimeType: part.inlineData.mimeType || 'image/jpeg',
                data: part.inlineData.data
              };
            }
            return cleanPart;
          }).filter((part: any) => part.text !== undefined || part.inlineData !== undefined);

          return {
            role: content.role || 'user',
            parts: sanitizedParts
          };
        }).filter((content: any) => content.parts && content.parts.length > 0);
      } else if (typeof resolvedContents === 'object' && resolvedContents !== null) {
        // If it is a standalone object (e.g. single Part or Content), simplify or wrap as simple text/data
        if (resolvedContents.text) {
          resolvedContents = resolvedContents.text;
        } else if (resolvedContents.inlineData && resolvedContents.inlineData.data) {
          resolvedContents = {
            parts: [{
              inlineData: {
                mimeType: resolvedContents.inlineData.mimeType || 'image/jpeg',
                data: resolvedContents.inlineData.data
              }
            }]
          };
        }
      }

      const response = await ai.models.generateContent({
        model: targetModel,
        contents: resolvedContents,
        config: config || {},
      });

      res.json({ text: response.text });
    } catch (err: any) {
      console.error('Error generating with Gemini on server:', err);
      res.status(500).json({ 
        error: err.message || 'An error occurred while generating content with the Gemini SDK.' 
      });
    }
  });

  // Serve Vite in development, or Static Files from dist/ in production
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  const port = 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`[Full-Stack Server] Live at http://0.0.0.0:${port}`);
  });
}

startServer();
