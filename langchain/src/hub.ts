import { Client } from "langsmith";
import { Runnable } from "@langchain/core/runnables";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import { load } from "./load/index.js";

/**
 * Push a prompt to the hub.
 * If the specified repo doesn't already exist, it will be created.
 * @param repoFullName The full name of the repo.
 * @param runnable The prompt to push.
 * @param options
 * @returns The URL of the newly pushed prompt in the hub.
 */
export async function push(
  repoFullName: string,
  runnable: Runnable,
  options?: {
    apiKey?: string;
    apiUrl?: string;
    parentCommitHash?: string;
    /** @deprecated Use isPublic instead. */
    newRepoIsPublic?: boolean;
    isPublic?: boolean;
    /** @deprecated Use description instead. */
    newRepoDescription?: string;
    description?: string;
    readme?: string;
    tags?: string[];
  }
) {
  const client = new Client(options);
  const payloadOptions = {
    object: runnable,
    parentCommitHash: options?.parentCommitHash,
    isPublic: options?.isPublic ?? options?.newRepoIsPublic,
    description: options?.description ?? options?.newRepoDescription,
    readme: options?.readme,
    tags: options?.tags,
  };
  return client.pushPrompt(repoFullName, payloadOptions);
}

/**
 * Pull a prompt from the hub.
 * @param ownerRepoCommit The name of the repo containing the prompt, as well as an optional commit hash separated by a slash.
 * @param options
 * @returns
 */
export async function pull<T extends Runnable>(
  ownerRepoCommit: string,
  options?: {
    apiKey?: string;
    apiUrl?: string;
    includeModel?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modelClass?: new (...args: any[]) => BaseLanguageModel;
  }
) {
  const client = new Client(options);

  const promptObject = await client.pullPromptCommit(ownerRepoCommit, {
    includeModel: options?.includeModel,
  });

  if (promptObject.manifest.kwargs?.metadata === undefined) {
    promptObject.manifest.kwargs = {
      ...promptObject.manifest.kwargs,
      metadata: {},
    };
  }

  promptObject.manifest.kwargs.metadata = {
    ...promptObject.manifest.kwargs.metadata,
    lc_hub_owner: promptObject.owner,
    lc_hub_repo: promptObject.repo,
    lc_hub_commit_hash: promptObject.commit_hash,
  };

  const modelImportMap: Record<string, any> = {};
  // TODO: Fix in 0.4.0. We can't get lc_id without instantiating the class, so we
  // must put them inline here. In the future, make this less hacky
  // This should probably use dynamic imports and have a web-only entrypoint
  // in a future breaking release
  if (options?.modelClass !== undefined) {
    const modelLcName = (options.modelClass as any)?.lc_name();
    let importMapKey;
    if (modelLcName === "ChatAnthropic") {
      importMapKey = "chat_models__anthropic";
    } else if (modelLcName === "ChatAzureOpenAI") {
      importMapKey = "chat_models__openai";
    } else if (modelLcName === "ChatGoogleVertexAI") {
      importMapKey = "chat_models__vertexai";
    } else if (modelLcName === "ChatGoogleGenerativeAI") {
      importMapKey = "chat_models__google_genai";
    } else if (modelLcName === "ChatBedrockConverse") {
      importMapKey = "chat_models__chat_bedrock_converse";
    } else if (modelLcName === "ChatMistral") {
      importMapKey = "chat_models__mistralai";
    } else if (modelLcName === "ChatFireworks") {
      importMapKey = "chat_models__fireworks";
    } else if (modelLcName === "ChatGroq") {
      importMapKey = "chat_models__groq";
    } else {
      throw new Error("Received unsupport model class when pulling prompt.");
    }
    modelImportMap[importMapKey] = {
      ...modelImportMap[importMapKey],
      [modelLcName]: options.modelClass,
    };
  }

  // Some nested mustache prompts have improperly parsed variables that include a dot.
  if (promptObject.manifest.kwargs.template_format === "mustache") {
    const stripDotNotation = (varName: string) => varName.split(".")[0];

    const { input_variables } = promptObject.manifest.kwargs;
    if (Array.isArray(input_variables)) {
      promptObject.manifest.kwargs.input_variables =
        input_variables.map(stripDotNotation);
    }

    const { messages } = promptObject.manifest.kwargs;
    if (Array.isArray(messages)) {
      promptObject.manifest.kwargs.messages = messages.map((message: any) => {
        const nestedVars = message?.kwargs?.prompt?.kwargs?.input_variables;
        if (Array.isArray(nestedVars)) {
          // eslint-disable-next-line no-param-reassign
          message.kwargs.prompt.kwargs.input_variables =
            nestedVars.map(stripDotNotation);
        }
        return message;
      });
    }
  }

  try {
    const loadedPrompt = await load<T>(
      JSON.stringify(promptObject.manifest),
      undefined,
      undefined,
      modelImportMap
    );
    return loadedPrompt;
  } catch (e: any) {
    if (options?.includeModel && options?.modelClass === undefined) {
      throw new Error(
        [
          e.message,
          "",
          `To load prompts with an associated non-OpenAI model, you must pass a "modelClass" parameter like this:`,
          "",
          "```",
          `import { ChatAnthropic } from "@langchain/anthropic";`,
          "",
          `const prompt = await pull("my-prompt", {`,
          `  includeModel: true,`,
          `  modelClass: ChatAnthropic,`,
          `});`,
          "```",
        ].join("\n")
      );
    } else {
      throw e;
    }
  }
}
