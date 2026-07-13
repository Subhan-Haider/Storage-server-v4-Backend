const axios = require('axios');
const fs = require('fs');
const path = require('path');

async function fixWithAI(projectId, logs, projectPath, settings) {
    const { provider, model, apiKey } = settings;
    
    // Grab main project files for context
    let contextFiles = "";
    try {
        const filesToRead = ['package.json', 'server.ts', 'server.js', 'next.config.js', 'vite.config.ts', 'pm2-runner.cjs', 'pm2-runner.js'];
        for (const file of filesToRead) {
            const fullPath = path.join(projectPath, file);
            if (fs.existsSync(fullPath)) {
                contextFiles += `\n--- ${file} ---\n${fs.readFileSync(fullPath, 'utf8')}\n`;
            }
        }
    } catch (e) {
        console.error("Error reading context files", e);
    }

    const systemPrompt = `You are an expert DevOps engineer and Senior Developer. 
A deployment has crashed or failed to build. Your job is to analyze the logs and the source code, find the bug, and provide a fix.

=== LOGS ===
${logs.substring(Math.max(0, logs.length - 5000))}

=== SOURCE CODE CONTEXT ===
${contextFiles}

You MUST respond in valid JSON format ONLY. Do not include markdown codeblocks around the JSON.
Format:
{
  "explanation": "A short, 1-2 sentence explanation of what went wrong and how you fixed it.",
  "fileToModify": "The relative path to the file that needs fixing (e.g. server.js)",
  "newCode": "The COMPLETE, fully rewritten code for that file. Do not use placeholders."
}`;

    let responseText = "";

    try {
        if (provider === 'ollama') {
            const res = await axios.post('http://127.0.0.1:11434/api/generate', {
                model: model || 'llama3',
                prompt: systemPrompt,
                stream: false,
                format: 'json'
            });
            responseText = res.data.response;
        } else if (provider === 'openrouter') {
            const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                model: model || 'google/gemini-2.5-flash',
                messages: [{ role: 'user', content: systemPrompt }],
                response_format: { type: "json_object" }
            }, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            responseText = res.data.choices[0].message.content;
        } else {
            throw new Error("Invalid AI provider selected.");
        }

        let cleanJson = responseText.trim();
        if (cleanJson.startsWith('```json')) cleanJson = cleanJson.substring(7);
        if (cleanJson.startsWith('```')) cleanJson = cleanJson.substring(3);
        if (cleanJson.endsWith('```')) cleanJson = cleanJson.substring(0, cleanJson.length - 3);

        const parsed = JSON.parse(cleanJson);
        
        // Apply the fix directly
        if (parsed.fileToModify && parsed.newCode) {
            const targetPath = path.join(projectPath, parsed.fileToModify);
            fs.writeFileSync(targetPath, parsed.newCode);
        }

        return parsed;
    } catch (error) {
        console.error("AI Fixer Error:", error?.response?.data || error.message);
        throw new Error("Failed to generate AI fix: " + (error?.response?.data?.error?.message || error.message));
    }
}

module.exports = { fixWithAI };
