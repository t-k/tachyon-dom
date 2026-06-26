import {
  createConnection,
  DiagnosticSeverity,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  type Connection,
  type Diagnostic,
  type InitializeResult,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { diagnoseTachyonSfc } from "./diagnostics.js";

const source = "tachyon-dom";

export const diagnosticsForTachyonDocument = (text: string): Diagnostic[] => {
  const result = diagnoseTachyonSfc(text);
  if (result.ok) {
    return [];
  }
  const diagnostic = result.error;
  const line = Math.max(0, diagnostic.line - 1);
  const character = Math.max(0, diagnostic.column - 1);
  return [
    {
      message: diagnostic.message,
      range: {
        start: { line, character },
        end: { line, character: character + 4 },
      },
      severity: DiagnosticSeverity.Error,
      source,
    },
  ];
};

export const startLanguageServer = (connection: Connection = createConnection(ProposedFeatures.all)): void => {
  const documents = new TextDocuments(TextDocument);

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
    connection.sendDiagnostics({
      uri: event.document.uri,
      diagnostics: diagnosticsForTachyonDocument(event.document.getText()),
    });
  });

  documents.onDidClose((event) => {
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  });

  documents.listen(connection);
  connection.listen();
};
