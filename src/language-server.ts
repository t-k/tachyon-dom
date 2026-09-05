import type { Connection, Diagnostic, InitializeResult } from "vscode-languageserver/node";
import { diagnoseTachyonSfc } from "./diagnostics.js";
import { requireOptionalPeer } from "./optional-peer.js";

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

export const diagnosticsForTachyonDocument = (text: string): Diagnostic[] => {
  const result = diagnoseTachyonSfc(text, { target: "stream" });
  if (result.ok) {
    return [];
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
            diagnostics: diagnosticsForTachyonDocument(document.getText()),
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
      },
    }),
  );

  documents.onDidOpen((event) => {
    connection.sendDiagnostics({
      uri: event.document.uri,
      diagnostics: diagnosticsForTachyonDocument(event.document.getText()),
    });
  });

  documents.onDidChangeContent((event) => {
    diagnostics.schedule(event.document);
  });

  documents.onDidClose((event) => {
    diagnostics.clear(event.document.uri);
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  });

  documents.listen(connection);
  connection.listen();
};
