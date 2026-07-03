import axios, { AxiosRequestConfig } from "axios";
import { PYTHON_URLS } from "../config/env";

/**
 * Makes an HTTP request to Python backend with automatic fallback to alternate URLs
 * Tries each URL in PYTHON_URLS array until one succeeds or all fail
 */
export async function callPythonBackend(
  endpoint: string,
  data: any,
  config?: AxiosRequestConfig
): Promise<any> {
  const errors: Error[] = [];

  for (const baseUrl of PYTHON_URLS) {
    try {
      const url = baseUrl.endsWith("/")
        ? `${baseUrl}${endpoint}`
        : `${baseUrl}/${endpoint}`;

      console.log(`[Python Backend] Trying URL: ${url}`);
      
      const response = await axios.post(url, data, {
        ...config,
        timeout: 10000, // 10 second timeout
      });

      if (response.status === 200) {
        console.log(`[Python Backend] Success with URL: ${url}`);
        return response.data;
      }
    } catch (error) {
      const err = error as Error;
      console.error(`[Python Backend] Failed with URL ${baseUrl}:`, err.message);
      errors.push(err);
    }
  }

  // All URLs failed
  throw new Error(
    `All Python backend URLs failed. Errors: ${errors.map(e => e.message).join(", ")}`
  );
}
