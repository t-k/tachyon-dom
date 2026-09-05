import type {
  CompletionItem,
  Connection,
  Diagnostic,
  Hover,
  InitializeResult,
  Location,
  Position,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver/node";
import { fileURLToPath } from "node:url";
import { diagnoseTachyonSfc } from "./diagnostics.js";
import { requireOptionalPeer } from "./optional-peer.js";
import { checkTachyonTemplateTypes, type TemplateTypeDiagnostic } from "./template-typecheck.js";
import { createTemplateLanguageFeatures } from "./template-language.js";
export {
  createTemplateLanguageFeatures,
  templateCompletionAt,
  templateDefinitionAt,
  templateHoverAt,
  templateRenameAt,
} from "./template-language.js";
export type {
  TemplateCompletionItem,
  TemplateDefinition,
  TemplateHover,
  TemplateLanguageFeatures,
  TemplateLanguagePosition,
  TemplateLanguageRange,
  TemplateRename,
  TemplateTextEdit,
} from "./template-language.js";
export {
  checkTachyonSfcTypes,
  checkTachyonTemplateTypes,
  diagnoseTachyonTemplateTypes,
  formatTemplateTypeDiagnostic,
} from "./template-typecheck.js";
export type { TemplateTypeCheckOptions, TemplateTypeDiagnostic } from "./template-typecheck.js";

type LanguageServerModule = typeof import("vscode-languageserver/node");
type TextDocumentModule = typeof import("vscode-languageserver-textdocument");

const source = "tachyon-dom";
type DiagnosticDocument = {
  uri: string;
  getText: () => string;
};

type DiagnosticPayload = {
  uri: string;
  diagnostics: Diagnostic[];
};

const fileNameForDocumentUri = (uri: string): string => {
  if (!uri.startsWith("file:")) return uri;
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
};

export const diagnosticsForTachyonDocument = (text: string, fileName?: string): Diagnostic[] => {
  const result = diagnoseTachyonSfc(text, { target: "stream" });
  if (result.ok) {
    const typeResult = checkTachyonTemplateTypes(text, fileName ? { fileName: fileNameForDocumentUri(fileName) } : {});
    if (!typeResult.ok) return [];
    return typeResult.value.map((diagnostic) => lspDiagnosticForTypeDiagnostic(diagnostic));
  }
  const diagnostic = result.error;
  const line = Math.max(0, diagnostic.line - 1);
  const character = Math.max(0, diagnostic.column - 1);
  const endLine = Math.max(line, diagnostic.endLine - 1);
  const endCharacter = Math.max(0, diagnostic.endColumn - 1);
  return [
    {
      message: diagnostic.message,
      range: {
        start: { line, character },
        end: { line: endLine, character: endCharacter },
      },
      severity: 1,
      source,
    },
  ];
};

const lspDiagnosticForTypeDiagnostic = (diagnostic: TemplateTypeDiagnostic): Diagnostic => ({
  message: diagnostic.message,
  range: {
    start: { line: Math.max(0, diagnostic.line - 1), character: Math.max(0, diagnostic.column - 1) },
    end: {
      line: Math.max(0, diagnostic.endLine - 1),
      character: Math.max(0, diagnostic.endColumn - 1),
    },
  },
  severity: diagnostic.category === "error" ? 1 : diagnostic.category === "warning" ? 2 : 3,
  code: diagnostic.code,
  source: "typescript",
});

export const createDiagnosticsScheduler = (
  sendDiagnostics: (payload: DiagnosticPayload) => void,
  delayMs = 80,
): {
  schedule: (document: DiagnosticDocument) => void;
  clear: (uri: string) => void;
  dispose: () => void;
} => {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const clear = (uri: string): void => {
    const timer = pending.get(uri);
    if (timer !== undefined) {
      clearTimeout(timer);
      pending.delete(uri);
    }
  };
  return {
    schedule: (document) => {
      clear(document.uri);
      pending.set(
        document.uri,
        setTimeout(() => {
          pending.delete(document.uri);
          sendDiagnostics({
            uri: document.uri,
            diagnostics: diagnosticsForTachyonDocument(document.getText(), document.uri),
          });
        }, delayMs),
      );
    },
    clear,
    dispose: () => {
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
    },
  };
};

export const startLanguageServer = (providedConnection?: Connection): void => {
  const { createConnection, ProposedFeatures, TextDocumentSyncKind, TextDocuments } =
    requireOptionalPeer<LanguageServerModule>(
      "vscode-languageserver",
      "The Tachyon language server",
      "vscode-languageserver/node",
    );
  const { TextDocument } = requireOptionalPeer<TextDocumentModule>(
    "vscode-languageserver-textdocument",
    "The Tachyon language server",
  );
  const connection = providedConnection ?? createConnection(ProposedFeatures.all);
  const documents = new TextDocuments(TextDocument);
  const diagnostics = createDiagnosticsScheduler((payload) => connection.sendDiagnostics(payload));

  connection.onInitialize(
    (): InitializeResult => ({
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        completionProvider: { triggerCharacters: ["<", "{", ":", "."] },
        hoverProvider: true,
        definitionProvider: true,
        renameProvider: true,
      },
    }),
  );

  documents.onDidOpen((event) => {
    connection.sendDiagnostics({
      uri: event.document.uri,
      diagnostics: diagnosticsForTachyonDocument(event.document.getText(), event.document.uri),
    });
  });

  documents.onDidChangeContent((event) => {
    diagnostics.schedule(event.document);
  });

  documents.onDidClose((event) => {
    diagnostics.clear(event.document.uri);
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  });

  connection.onCompletion((params): CompletionItem[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];
    return createTemplateLanguageFeatures(document.getText(), document.uri)
      .completion(params.position as Position)
      .map((item) => ({
        label: item.label,
        ...(item.detail ? { detail: item.detail } : {}),
        kind: item.kind === "directive" ? 14 : item.kind === "property" ? 10 : 6,
      }));
  });

  connection.onHover((params): Hover | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    return (
      (createTemplateLanguageFeatures(document.getText(), document.uri).hover(params.position as Position) as
        | Hover
        | undefined) ?? null
    );
  });

  connection.onDefinition((params): Location | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    return (
      (createTemplateLanguageFeatures(document.getText(), document.uri).definition(params.position as Position) as
        | Location
        | undefined) ?? null
    );
  });

  connection.onRenameRequest((params): WorkspaceEdit | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    const rename = createTemplateLanguageFeatures(document.getText(), document.uri).rename(
      params.position as Position,
      params.newName,
    );
    if (!rename) return null;
    return { changes: { [document.uri]: rename.edits as TextEdit[] } };
  });

  documents.listen(connection);
  connection.listen();
};
