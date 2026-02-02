/**
 * GLM Image Summary Extension
 *
 * When using glm-4.7, this extension intercepts image reads and sends them
 * to glm-4.6v for detailed analysis using a subprocess. This provides better
 * image understanding since glm-4.6v has stronger vision capabilities.
 *
 * Usage:
 *   pi -e ~/.pi/agent/extensions/pi-glm-image-summary --provider zai --model glm-4.7
 *
 * The extension will:
 * 1. Detect when glm-4.7 is the current model
 * 2. Check if the file being read is an image
 * 3. Call pi subprocess with glm-4.6v to analyze the image
 * 4. Return the summary text to glm-4.7
 */

import { spawn } from "node:child_process";
import type { TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	BorderedLoader,
	createReadTool,
	type ReadOperations,
	type ReadToolDetails,
} from "@mariozechner/pi-coding-agent";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { resolve } from "path";

const SUMMARY_PROMPT = `Please analyze this image comprehensively. Extract ALL information from the image including:

1. **Overall Description**: What type of content is this? (screenshot, diagram, document, photograph, UI, code, etc.)
2. **Text Content**: ALL visible text in the image, preserving structure and formatting. Include labels, buttons, error messages, file paths, code snippets, etc. Be exhaustive.
3. **Visual Elements**: Colors, layout, components, icons, graphical elements
4. **Technical Details**: For code, UI, diagrams - include exact values, class names, IDs, parameters, configurations
5. **Contextual Information**: Window titles, terminal prompts, file names, timestamps, status indicators
6. **Structure**: How elements are organized, relationships between components
7. **Actionable Information**: Any visible commands, settings, configurations, or parameters that could be useful

Format your response clearly with sections and bullet points. Be extremely thorough - the user needs to understand everything visible in this image to perform their task.`;

export default function (pi: ExtensionAPI) {
	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);

	// Custom read operations that detect images
	const readOps: ReadOperations = {
		readFile: (path) => fsReadFile(path),
		access: (path) => fsAccess(path, constants.R_OK),
		detectImageMimeType: async (absolutePath: string) => {
			// Simple MIME type detection
			const ext = absolutePath.split(".").pop()?.toLowerCase();
			const supported = ["jpg", "jpeg", "png", "gif", "webp"];
			if (ext && supported.includes(ext)) {
				return `image/${ext === "jpg" ? "jpeg" : ext}`;
			}
			return null;
		},
	};

	// Override the read tool
	pi.registerTool({
		...localRead,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { path } = params;
			const absolutePath = resolve(ctx.cwd, path);

			// Check if current model is glm-4.7
			const currentModel = ctx.model;
			const isGlm4_7 = currentModel?.id === "glm-4.7" || currentModel?.id === "glm-4.7-long";

			// If not glm-4.7, use standard read
			if (!isGlm4_7) {
				return localRead.execute(toolCallId, params, signal, onUpdate);
			}

			// Check if file is an image
			const mimeType = await readOps.detectImageMimeType?.(absolutePath);
			if (!mimeType) {
				// Not an image, use standard read
				return localRead.execute(toolCallId, params, signal, onUpdate);
			}

			// Call pi subprocess with glm-4.6v to analyze the image
			onUpdate?.({
				content: [{ type: "text", text: `[Analyzing image with glm-4.6v...]` }],
			});

			try {
				const result = await new Promise<{ text: string }>((resolveResult, reject) => {
					// Use @ prefix to indicate image attachment, and absolute path
					const args = [
						`@${absolutePath}`,
						"--provider",
						"zai",
						"--model",
						"glm-4.6v",
						"-p",
						SUMMARY_PROMPT,
						"--json", // Get structured output
					];

					const child = spawn("pi", args, {
						stdio: ["ignore", "pipe", "pipe"],
						env: process.env,
					});

					let stdout = "";
					let stderr = "";

					child.stdout.on("data", (data) => {
						stdout += data.toString();
					});

					child.stderr.on("data", (data) => {
						stderr += data.toString();
					});

					child.on("error", (err) => {
						reject(err);
					});

					child.on("close", (code) => {
						if (code !== 0) {
							reject(new Error(`pi subprocess failed (${code}): ${stderr}`));
						} else {
							resolveResult({ text: stdout.trim() });
						}
					});

					// Handle abort signal
					if (signal) {
						const onAbort = () => {
							child.kill();
							reject(new Error("Operation aborted"));
						};
						signal.addEventListener("abort", onAbort, { once: true });
						child.on("close", () => {
							signal.removeEventListener("abort", onAbort);
						});
					}
				});

				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}

				// Parse the result
				let summaryText: string;
				try {
					// Try to parse as JSON first
					const json = JSON.parse(result.text);
					// Extract message content from the response
					if (json.messages && Array.isArray(json.messages)) {
						// Get the last assistant message
						const assistantMsg = json.messages.findLast((m: any) => m.role === "assistant");
						if (assistantMsg?.content) {
							summaryText = assistantMsg.content
								.filter((c: any) => c.type === "text")
								.map((c: any) => c.text)
								.join("\n");
						} else {
							summaryText = result.text;
						}
					} else {
						summaryText = result.text;
					}
				} catch {
					// Not JSON, use as-is
					summaryText = result.text;
				}

				const readResult = {
					content: [
						{
							type: "text",
							text: `[Image analyzed with glm-4.6v]\n\n${summaryText}`,
						} as TextContent,
					],
					details: { summaryModel: "glm-4.6v" } as ReadToolDetails,
				};

				onUpdate?.(readResult);
				return readResult;
			} catch (error: any) {
				// Throw an error so it shows as red in the UI
				const errorMsg = `Image analysis failed with glm-4.6v: ${error.message}. The image may not be supported (e.g., animated GIFs) or there was a connection issue.`;
				const err = new Error(errorMsg);
				(err as any).isToolError = true; // Mark as a tool error for better handling
				throw err;
			}
		},
	});

	// Add a command to manually trigger image analysis
	pi.registerCommand("analyze-image", {
		description: "Analyze an image file using glm-4.6v",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("analyze-image requires interactive mode", "error");
				return;
			}

			const imagePath = args.trim();
			if (!imagePath) {
				ctx.ui.notify("Usage: /analyze-image <path-to-image>", "error");
				return;
			}

			const absolutePath = resolve(ctx.cwd, imagePath);

			// Check if file is an image
			const mimeType = await readOps.detectImageMimeType?.(absolutePath);
			if (!mimeType) {
				ctx.ui.notify("Not a supported image file", "error");
				return;
			}

			// Call pi subprocess with glm-4.6v to analyze the image
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Analyzing ${imagePath}...`);
				loader.onAbort = () => done(null);

				// Use @ prefix to indicate image attachment, and absolute path
				const args = [
					`@${absolutePath}`,
					"--provider",
					"zai",
					"--model",
					"glm-4.6v",
					"-p",
					SUMMARY_PROMPT,
					"--json",
				];

				const child = spawn("pi", args, {
					stdio: ["ignore", "pipe", "pipe"],
					env: process.env,
				});

				let stdout = "";
				let stderr = "";

				child.stdout.on("data", (data) => {
					stdout += data.toString();
				});

				child.stderr.on("data", (data) => {
					stderr += data.toString();
				});

				child.on("error", (err) => {
					console.error("Image analysis failed:", err);
					ctx.ui.notify(`Analysis failed: ${err.message}`, "error");
					done(null);
				});

				child.on("close", (code) => {
					if (code !== 0) {
						console.error("Image analysis failed:", stderr);
						ctx.ui.notify(`Analysis failed: ${stderr}`, "error");
						done(null);
						return;
					}

					let summaryText: string;
					try {
						const json = JSON.parse(stdout);
						if (json.messages && Array.isArray(json.messages)) {
							const assistantMsg = json.messages.findLast((m: any) => m.role === "assistant");
							if (assistantMsg?.content) {
								summaryText = assistantMsg.content
									.filter((c: any) => c.type === "text")
									.map((c: any) => c.text)
									.join("\n");
							} else {
								summaryText = stdout;
							}
						} else {
							summaryText = stdout;
						}
					} catch {
						summaryText = stdout;
					}

					done(summaryText);
				});

				if (loader.signal.aborted) {
					child.kill();
				}

				loader.signal.addEventListener("abort", () => {
					child.kill();
				});

				return loader;
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Show the analysis
			await ctx.ui.editor("Image Analysis", result);
		},
	});
}
