import { Env, Tool } from "../types";
import {
	GroundingMetadata,
	NativeTool,
	NativeToolsConfiguration,
	NativeToolsEnvSettings,
	NativeToolsRequestParams
} from "../types/native-tools";
import { CitationsProcessor } from "./citations-processor";
import { NATIVE_TOOLS_DEFAULTS } from "../constants";

/**
 * Manages the integration of native Gemini tools, including Google Search,
 * URL Context. Handles tool compatibility, priority,
 * and configuration based on environment settings and request parameters.
 */
export class NativeToolsManager {
	private envSettings: NativeToolsEnvSettings;
	private citationsProcessor: CitationsProcessor;

	constructor(env: Env) {
		this.envSettings = this.parseEnvironmentSettings(env);
		this.citationsProcessor = new CitationsProcessor(env);
	}

	/**
	 * Determines the final tool configuration based on environment settings,
	 * request parameters, and tool compatibility rules.
	 */
	public determineToolConfiguration(
		customTools: Tool[],
		requestParams: NativeToolsRequestParams,
		modelId: string
	): NativeToolsConfiguration {
		const hasCustomTools = customTools.length > 0;
		const nativeToolsAvailable = this.envSettings.enableGoogleSearch || this.envSettings.enableUrlContext;

		// Handle disabled native tools
		if (!this.envSettings.enableNativeTools) {
			return this.createCustomOnlyConfig(customTools);
		}

		// Respect explicit request disabling of native tools (when allowed)
		if (this.envSettings.allowRequestControl && requestParams.enableNativeTools === false) {
			return this.createCustomOnlyConfig(customTools);
		}

		// Decide whether native tools are requested.
		// IMPORTANT: When custom tools are present, we do NOT enable native tools by default,
		// because the Code Assist endpoint rejects mixing native search tools with function tools.
		const nativeRequestedExplicitly =
			this.envSettings.allowRequestControl &&
			(requestParams.enableNativeTools === true || requestParams.enableSearch === true || requestParams.enableUrlContext === true);
		const shouldDefaultToNative = this.envSettings.defaultToNativeTools && !hasCustomTools;
		const shouldConsiderNative = nativeToolsAvailable && (nativeRequestedExplicitly || shouldDefaultToNative);

		// Handle Google Search + URL Context combination
		if (shouldConsiderNative) {
			return this.createSearchAndUrlConfig(requestParams, customTools, modelId);
		}

		// No native tools requested - use custom tools
		return this.createCustomOnlyConfig(customTools);
	}

	/**
	 * Creates the array of native tools to be sent to the Gemini API.
	 */
	public createNativeToolsArray(params: NativeToolsRequestParams, modelId: string): NativeTool[] {
		const tools: NativeTool[] = [];

		// Priority 1: Google Search + URL Context (compatible)
		if (this.shouldEnableGoogleSearch(params)) {
			if (!this.isLegacyModel(modelId)) {
				tools.push({ google_search: {} });
			}
		}

		if (this.shouldEnableUrlContext(params) && !this.shouldEnableGoogleSearch(params)) {
			tools.push({ url_context: {} });
		}

		return tools;
	}

	/**
	 * Processes text to add inline citations if enabled.
	 */
	public processCitationsInText(text: string, groundingMetadata?: GroundingMetadata): string {
		return this.citationsProcessor.processChunk(text, groundingMetadata);
	}

	private createSearchAndUrlConfig(
		requestParams: NativeToolsRequestParams,
		customTools: Tool[],
		modelId: string
	): NativeToolsConfiguration {
		const nativeTools = this.createNativeToolsArray(requestParams, modelId);

		// NOTE: The Code Assist endpoint rejects requests that mix native search tools
		// (google_search/url_context) with custom function tools in the same request:
		// "Multiple tools are supported only when they are all search tools."
		// Therefore, we must choose either native OR custom tools based on priority.

		if (this.envSettings.priority === "native_first" || requestParams.nativeToolsPriority === "native") {
			return {
				useNativeTools: true,
				useCustomTools: false,
				nativeTools,
				customTools: undefined,
				priority: "native",
				toolType: "search_and_url"
			};
		} else if (
			(this.envSettings.priority === "custom_first" || requestParams.nativeToolsPriority === "custom") &&
			customTools.length > 0
		) {
			return this.createCustomOnlyConfig(customTools);
		} else {
			// Default to native tools (do not mix with custom tools)
			return {
				useNativeTools: true,
				useCustomTools: false,
				nativeTools,
				customTools: undefined,
				priority: "native",
				toolType: "search_and_url"
			};
		}
	}

	private createCustomOnlyConfig(customTools: Tool[]): NativeToolsConfiguration {
		return {
			useNativeTools: false,
			useCustomTools: true,
			nativeTools: [],
			customTools,
			priority: "custom",
			toolType: "custom_only"
		};
	}

	private shouldEnableGoogleSearch(params: NativeToolsRequestParams): boolean {
		if (params.enableSearch === false) return false;
		if (params.enableSearch === true) return true;
		return this.envSettings.enableGoogleSearch;
	}

	private shouldEnableUrlContext(params: NativeToolsRequestParams): boolean {
		if (params.enableUrlContext === false) return false;
		if (params.enableUrlContext === true) return true;
		return this.envSettings.enableUrlContext;
	}

	private isLegacyModel(modelId: string): boolean {
		return modelId.includes("gemini-1.5");
	}

	private parseEnvironmentSettings(env: Env): NativeToolsEnvSettings {
		return {
			enableNativeTools: env.ENABLE_GEMINI_NATIVE_TOOLS === "true",
			enableGoogleSearch: env.ENABLE_GOOGLE_SEARCH === "true",
			enableUrlContext: env.ENABLE_URL_CONTEXT === "true",
			priority:
				(env.GEMINI_TOOLS_PRIORITY as NativeToolsEnvSettings["priority"]) ||
				NATIVE_TOOLS_DEFAULTS.GEMINI_TOOLS_PRIORITY,
			defaultToNativeTools: env.DEFAULT_TO_NATIVE_TOOLS !== "false",
			allowRequestControl: env.ALLOW_REQUEST_TOOL_CONTROL !== "false",
			enableInlineCitations: env.ENABLE_INLINE_CITATIONS === "true",
			includeGroundingMetadata: env.INCLUDE_GROUNDING_METADATA !== "false",
			includeSearchEntryPoint: env.INCLUDE_SEARCH_ENTRY_POINT === "true"
		};
	}
}
