/**
 * Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

import {Analyzer, applyEdits, Edit, isPositionInsideRange, makeParseLoader, SourceRange, Warning} from 'polymer-analyzer';
import {Linter, registry, Rule} from 'polymer-linter';
import {CodeActionParams, Command, Diagnostic, IConnection, TextDocuments, TextEdit, WorkspaceEdit} from 'vscode-languageserver';

import {applyEditCommandName} from './commands';
import AnalyzerLSPConverter from './converter';
import FileSynchronizer from './file-synchronizer';
import Settings from './settings';
import {Handler} from './util';

/**
 * Handles publishing diagnostics and code actions on those diagnostics.
 */
export default class DiagnosticGenerator extends Handler {
  private linter: Linter;
  constructor(
      private analyzer: Analyzer, private converter: AnalyzerLSPConverter,
      protected connection: IConnection, private settings: Settings,
      fileSynchronizer: FileSynchronizer, private documents: TextDocuments) {
    super();

    connection.onDidCloseTextDocument((event) => {
      if (!settings.analyzeWholePackage) {
        // If the user hasn't asked for whole-package analysis then it's
        // annoying to see warnings for files that aren't open, and in any
        // case, we'll never update those diagnostics while the file is closed.
        connection.sendDiagnostics(
            {diagnostics: [], uri: event.textDocument.uri});
      }
    });

    settings.projectConfigChangeStream.listen(() => {
      this.updateLinter();
    });
    this.disposables.push(fileSynchronizer.fileChanges.listen(() => {
      this.reportWarnings();
    }));
    settings.changeStream.listen(({newer, older}) => {
      if (newer.analyzeWholePackage !== older.analyzeWholePackage) {
        // When we switch this setting we want to be sure that we'll clear out
        // warnings that were reported with the old setting but not the new
        // one.
        if (newer.analyzeWholePackage) {
          this.urisReportedWarningsFor = new Set(this.documents.keys());
        } else {
          for (const uri of this.urisReportedWarningsFor) {
            this.connection.sendDiagnostics({uri, diagnostics: []});
          }
        }
        this.reportWarnings();
      }
    });

    this.connection.onCodeAction(async(req) => {
      return this.handleErrors(this.getCodeActions(req), []);
    });

    this.updateLinter();
  }

  async getAllFixes(): Promise<WorkspaceEdit> {
    const warnings = await this.linter.lintPackage();
    const fixes = [];
    for (const warning of warnings) {
      if (warning.fix) {
        fixes.push(warning.fix);
      }
    }
    // Don't apply conflicting edits to the workspace.
    const parseLoader = makeParseLoader(this.analyzer, warnings.analysis);
    const {appliedEdits} = await applyEdits(fixes, parseLoader);
    return this.converter.editsToWorkspaceEdit(appliedEdits);
  }

  async getFixesForFile(uri: string): Promise<TextEdit[]> {
    const path = this.converter.getWorkspacePathToFile({uri});
    const warnings = await this.linter.lint([path]);
    const edits: Edit[] = [];
    for (const warning of warnings) {
      if (!warning.fix) {
        continue;
      }
      // A fix can touch multiple files. We can only update this document
      // though, so skip any fixes that touch others.
      if (warning.fix.some(repl => repl.range.file !== path)) {
        continue;
      }
      edits.push(warning.fix);
    }
    const {appliedEdits} = await applyEdits(
        edits, makeParseLoader(this.analyzer, warnings.analysis));
    const textEdits: TextEdit[] = [];
    for (const appliedEdit of appliedEdits) {
      for (const replacement of appliedEdit) {
        textEdits.push(TextEdit.replace(
            this.converter.convertPRangeToL(replacement.range),
            replacement.replacementText));
      }
    }
    return textEdits;
  }

  private updateLinter() {
    let rules: Iterable<Rule> = new Set();
    const projectConfig = this.settings.projectConfig;
    if (projectConfig.lint && projectConfig.lint.rules) {
      try {
        rules = registry.getRules(projectConfig.lint.rules);
      } catch (e) {
        // TODO(rictic): let the user know about this error, and about
        //   this.settings.projectConfigDiagnostic if it exists.
      }
    }

    const linter = new Linter(rules, this.analyzer);
    this.linter = linter;
    this.reportWarnings();
  }

  /**
   * Used so that if we don't have any warnings to report for a file on the
   * next go around we can remember to send an empty array.
   */
  private urisReportedWarningsFor = new Set<string>();
  private async reportWarnings(): Promise<void> {
    if (this.settings.analyzeWholePackage) {
      const warnings = await this.linter.lintPackage();
      this.reportPackageWarnings(warnings);
    } else {
      const warnings = await this.linter.lint(this.documents.keys().map(
          uri => this.converter.getWorkspacePathToFile({uri})));
      const diagnosticsByUri = new Map<string, Diagnostic[]>();
      for (const warning of warnings) {
        const diagnostic = this.converter.convertWarningToDiagnostic(warning);
        let diagnostics =
            diagnosticsByUri.get(
                this.converter.getUriForLocalPath(warning.sourceRange.file)) ||
            [];
        diagnostics.push(diagnostic);
        diagnosticsByUri.set(
            this.converter.getUriForLocalPath(warning.sourceRange.file),
            diagnostics);
      }

      for (const [uri, diagnostics] of diagnosticsByUri) {
        this.connection.sendDiagnostics({uri, diagnostics});
      }
    }
  }

  /**
   * Report the given warnings for the package implicitly defined by the
   * workspace.
   *
   * This is pulled out into its own non-async function to document and maintain
   * the invariant that there must not be an await between the initial read of
   * urisReportedWarningsFor and the write of it at the end.
   */
  private reportPackageWarnings(warnings: Iterable<Warning>) {
    const reportedLastTime = new Set(this.urisReportedWarningsFor);
    this.urisReportedWarningsFor = new Set<string>();
    const diagnosticsByUri = new Map<string, Diagnostic[]>();
    for (const warning of warnings) {
      const uri = this.converter.getUriForLocalPath(warning.sourceRange.file);
      reportedLastTime.delete(uri);
      this.urisReportedWarningsFor.add(uri);
      let diagnostics = diagnosticsByUri.get(uri);
      if (!diagnostics) {
        diagnostics = [];
        diagnosticsByUri.set(uri, diagnostics);
      }
      diagnostics.push(this.converter.convertWarningToDiagnostic(warning));
    }
    for (const [uri, diagnostics] of diagnosticsByUri) {
      this.connection.sendDiagnostics({uri, diagnostics});
    }
    for (const uriWithNoWarnings of reportedLastTime) {
      this.connection.sendDiagnostics(
          {uri: uriWithNoWarnings, diagnostics: []});
    }
    this.urisReportedWarningsFor = new Set(diagnosticsByUri.keys());
  }

  private async getCodeActions(req: CodeActionParams) {
    const commands: Command[] = [];
    if (req.context.diagnostics.length === 0) {
      // Currently we only support code actions on Warnings,
      // so we can early-exit in the case where there aren't any.
      return commands;
    }
    const warnings = await this.linter.lint(
        [this.converter.getWorkspacePathToFile(req.textDocument)]);
    const requestedRange =
        this.converter.convertLRangeToP(req.range, req.textDocument);
    for (const warning of warnings) {
      if ((!warning.fix &&
           (!warning.actions || warning.actions.length === 0)) ||
          !isRangeInside(warning.sourceRange, requestedRange)) {
        continue;
      }
      if (warning.fix) {
        commands.push(this.createApplyEditCommand(
            `Quick fix the '${warning.code}' warning`, warning.fix));
      }
      if (warning.actions) {
        for (const action of warning.actions) {
          if (action.kind !== 'edit') {
            continue;
          }
          commands.push(this.createApplyEditCommand(
              // Take up to the first newline.
              action.description.split('\n')[0], action.edit));
        }
      }
    }
    return commands;
  }

  private createApplyEditCommand(title: string, edit: Edit): Command {
    return Command.create(
        title, applyEditCommandName, this.converter.editToWorkspaceEdit(edit));
  }
}

function isRangeInside(inner: SourceRange, outer: SourceRange) {
  return isPositionInsideRange(inner.start, outer, true) &&
      isPositionInsideRange(inner.end, outer, true);
}
