/**
 * @module VSCodePvsWorkspaceExplorer
 * @author Paolo Masci
 * @date 2019.06.18
 * @copyright 
 * Copyright 2019 United States Government as represented by the Administrator 
 * of the National Aeronautics and Space Administration. All Rights Reserved.
 *
 * Disclaimers
 *
 * No Warranty: THE SUBJECT SOFTWARE IS PROVIDED "AS IS" WITHOUT ANY
 * WARRANTY OF ANY KIND, EITHER EXPRESSED, IMPLIED, OR STATUTORY,
 * INCLUDING, BUT NOT LIMITED TO, ANY WARRANTY THAT THE SUBJECT SOFTWARE
 * WILL CONFORM TO SPECIFICATIONS, ANY IMPLIED WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR FREEDOM FROM
 * INFRINGEMENT, ANY WARRANTY THAT THE SUBJECT SOFTWARE WILL BE ERROR
 * FREE, OR ANY WARRANTY THAT DOCUMENTATION, IF PROVIDED, WILL CONFORM TO
 * THE SUBJECT SOFTWARE. THIS AGREEMENT DOES NOT, IN ANY MANNER,
 * CONSTITUTE AN ENDORSEMENT BY GOVERNMENT AGENCY OR ANY PRIOR RECIPIENT
 * OF ANY RESULTS, RESULTING DESIGNS, HARDWARE, SOFTWARE PRODUCTS OR ANY
 * OTHER APPLICATIONS RESULTING FROM USE OF THE SUBJECT SOFTWARE.
 * FURTHER, GOVERNMENT AGENCY DISCLAIMS ALL WARRANTIES AND LIABILITIES
 * REGARDING THIRD-PARTY SOFTWARE, IF PRESENT IN THE ORIGINAL SOFTWARE,
 * AND DISTRIBUTES IT "AS IS."
 *
 * Waiver and Indemnity: RECIPIENT AGREES TO WAIVE ANY AND ALL CLAIMS
 * AGAINST THE UNITED STATES GOVERNMENT, ITS CONTRACTORS AND
 * SUBCONTRACTORS, AS WELL AS ANY PRIOR RECIPIENT.  IF RECIPIENT'S USE OF
 * THE SUBJECT SOFTWARE RESULTS IN ANY LIABILITIES, DEMANDS, DAMAGES,
 * EXPENSES OR LOSSES ARISING FROM SUCH USE, INCLUDING ANY DAMAGES FROM
 * PRODUCTS BASED ON, OR RESULTING FROM, RECIPIENT'S USE OF THE SUBJECT
 * SOFTWARE, RECIPIENT SHALL INDEMNIFY AND HOLD HARMLESS THE UNITED
 * STATES GOVERNMENT, ITS CONTRACTORS AND SUBCONTRACTORS, AS WELL AS ANY
 * PRIOR RECIPIENT, TO THE EXTENT PERMITTED BY LAW.  RECIPIENT'S SOLE
 * REMEDY FOR ANY SUCH MATTER SHALL BE THE IMMEDIATE, UNILATERAL
 * TERMINATION OF THIS AGREEMENT.
 **/
import { ExtensionContext, TreeItemCollapsibleState, commands, window,
			Uri, Range, Position, TreeItem, Command, EventEmitter, Event,
			TreeDataProvider, workspace, TreeView, ViewColumn, WorkspaceEdit, TextEditor, FileStat, ProgressLocation, ConfigurationTarget } from 'vscode';
import { LanguageClient } from 'vscode-languageclient';
import { FormulaDescriptor, TheoryDescriptor, PvsContextDescriptor, ProofStatus, PvsFileDescriptor, serverRequest, serverEvent, PvsFormula, PvsTheory, PvsFile } from '../common/serverInterface';
import * as path from 'path';
import * as fsUtils from '../common/fsUtils';
import * as utils from '../common/languageUtils';
import { VSCodePvsProofExplorer } from './vscodePvsProofExplorer';
import * as vscodeUtils from '../utils/vscode-utils';

//-- files
class PvsFileItem extends TreeItem {
	contextValue: string = "pvs-file";
	theoryName: string;
	command: Command;
	fileName: string;
	fileExtension: string;
	path: string;
	contextFolder: string;
	theoriesOverview: TheoriesOverviewItem;
	/**
	 * Constructor
	 */
	constructor () {
		super("Loading file descriptor...");
		this.theoriesOverview = new TheoriesOverviewItem();
	}
	updateFileDescriptor (desc: PvsFileDescriptor, opt?: { tccDescriptor?: boolean }): void {
		this.label = this.fileName = desc.fileName;
		this.fileExtension = desc.fileExtension;
		this.contextFolder = desc.contextFolder;
		this.path = path.join(desc.contextFolder, `${desc.fileName}${desc.fileExtension}`);
		this.command = {
			title: "PVS file selected",
			command: "explorer.didSelectPvsFile",
			arguments: [ desc ]
		};
		this.theoriesOverview.updateTheories(desc.theories, opt);
		this.refreshLabel();		
	}
	refreshLabel () {
		// update label
		this.label = `${this.fileName}${this.fileExtension}`;
		this.tooltip = this.path;
		// update collapsible state
		const n: number = this.theoriesOverview.theories ? this.theoriesOverview.theories.length : 0;
		this.collapsibleState = (n > 0) ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None;
	}
	updateFormula (desc: FormulaDescriptor): void {
		this.theoriesOverview.updateFormula(desc);
	}
	sort (): void {
		this.theoriesOverview.sort();
	}
	getChildren (): TreeItem[] {
		return this.theoriesOverview.getChildren();
	}
	getTheoryItem (desc: { contextFolder: string, fileName: string, fileExtension: string, theoryName: string }): TheoryItem {
		if (this.theoriesOverview) {
			return this.theoriesOverview.getTheoryItem(desc.theoryName);
		}
		return null;
	}
}
//-- theories
export class TheoryItem extends TreeItem {
	contextValue: string = "theory";
	theoryName: string;
	command: Command;
	fileName: string;
	fileExtension: string;
	path: string;
	position: Position;
	protected tccsOverview: TccsOverviewItem;
	protected theoremsOverview: TheoremsOverviewItem;
	contextFolder: string;
	/**
	 * Constructor
	 */
	constructor (desc: TheoryDescriptor, collapsibleState?: TreeItemCollapsibleState) {
		super(desc.theoryName, collapsibleState);
		this.theoryName = desc.theoryName;
		this.fileName = desc.fileName;
		this.fileExtension = desc.fileExtension;
		this.contextFolder = desc.contextFolder;
		this.path = path.join(desc.contextFolder, `${desc.fileName}${desc.fileExtension}`);
		this.position = (desc.position) ? new Position(desc.position.line, desc.position.character) : new Position(0, 0);
		this.command = {
			title: "Theory selected",
			command: "explorer.didSelectTheory",
			arguments: [ desc ]
		};
		this.theoremsOverview = new TheoremsOverviewItem(desc);
		this.tccsOverview = new TccsOverviewItem(desc);
		this.refreshLabel();
	}
	refreshLabel () {
		// update label
		const nTheorems: number = this.theoremsOverview.getTotal();
		const nTccs: number = this.tccsOverview.getTotal();
		const n: number = nTccs + nTheorems;
		this.label = `${this.theoryName}  (${this.fileName}${this.fileExtension}, Ln ${this.position.line})`;
		this.tooltip = `theory ${this.theoryName}`;
		// update collapsible state
		this.collapsibleState = (n > 0) ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None;
	}
	getFormula (formulaName: string): FormulaItem {
		return this.theoremsOverview.getFormula(formulaName);
	}
	updateFormula (desc: FormulaDescriptor): void {
		this.theoremsOverview.updateStatus(desc);
	}
	getTcc (formulaName: string): FormulaItem {
		return this.tccsOverview.getFormula(formulaName);
	}
	updateTcc (desc: FormulaDescriptor): void {
		this.tccsOverview.updateStatus(desc);
	}
	setTccs (desc: FormulaDescriptor[]): void {
		this.tccsOverview.setTccs(desc);
	}
	getTheoremsOverview (): TheoremsOverviewItem {
		return this.theoremsOverview;
	}
	getTheorems (): FormulaItem[] {
		return (this.theoremsOverview) ? this.theoremsOverview.getChildren() : [];
	}
	getTccsOverview (): TheoremsOverviewItem {
		return this.tccsOverview;
	}
	getTCCs (): FormulaItem[] {
		return (this.tccsOverview) ? this.tccsOverview.getChildren() : [];
	}
}
class LoadingItem extends TreeItem {
	contextValue: string = "loading-content";
	message: string = "Loading"
	protected points: number = 0;
	protected MAX_POINTS: number = 3;
	protected timer: NodeJS.Timer;
	constructor () {
		super ("loading-content", TreeItemCollapsibleState.None);
		this.label = this.message;
	}
	start (): Promise<void> {
		return new Promise((resolve, reject) => {
			this.loading();
			const timeout: number = this.points < this.MAX_POINTS ? 400 : 1000;
			this.timer = setInterval(() => {
				this.loading();
				resolve();
			}, timeout);
		});
	}
	protected loading (): void {
		this.label = this.message + ".".repeat(this.points);
		this.points = this.points < this.MAX_POINTS ? this.points + 1 : 0;
	}
	stop (): void {
		this.points = 0;
		clearInterval(this.timer);
		this.timer = null;
	}
}
abstract class OverviewItem extends TreeItem {
	contextValue: string = "abstract-overview";
	contextFolder: string;
	name: string;
	constructor(type: string, desc: { contextFolder?: string }, collapsibleState?: TreeItemCollapsibleState) {
		super(type, collapsibleState | TreeItemCollapsibleState.None);
		this.contextValue = type;
		this.label = this.name = type.replace("-overview", "");
		this.contextFolder = (desc && desc.contextFolder) ? desc.contextFolder : "";
	}
	getContextFolder (): string {
		return this.contextFolder;
	}
}
export class FormulaOverviewItem extends OverviewItem {
	contextValue: string = "formula-overview";
	theorems: FormulaItem[] = [];
	theoryName: string;
	fileName: string;
	fileExtension: string;
	constructor(type: string, desc: TheoryDescriptor, collapsibleState?: TreeItemCollapsibleState) {
		super(type, desc, collapsibleState);
		this.fileName = desc.fileName;
		this.fileExtension = desc.fileExtension;
		this.theoryName = desc.theoryName;
	}
	getFormula (formulaName: string): FormulaItem {
		const candidates: FormulaItem[] = this.theorems.filter((elem: FormulaItem) => {
			return elem.getFormulaName() === formulaName;
		});
		if (candidates && candidates.length === 1) {
			return candidates[0]
		}
		return null;
	}
	getChildren (): FormulaItem[] {
		return this.theorems;
	}
	protected refreshLabel () {
		const nTheorems: number = (this.theorems) ? this.theorems.length : 0;
		const nProved: number = (this.theorems) ? this.theorems.filter((item: FormulaItem) => {
			return item.getStatus() === "proved";
		}).length : 0;
		if (nProved === nTheorems) {
			// this.label = `${utils.icons.checkmark} ${this.name}  (${nProved} proved)`;
			this.label = `${this.name}  (${nProved} proved)`;
			this.iconPath = {
				light: path.join(__dirname, "..", "..", "..", "icons", "svg-checkmark.svg"),
				dark: path.join(__dirname, "..", "..", "..", "icons", "svg-checkmark.svg")
			};
		} else {
			// this.label = `${utils.icons.whitecircle} ${this.name}  (${nProved} proved, ${nTheorems-nProved} to be proved)`;
			this.label = `${this.name}  (${nProved} proved, ${nTheorems-nProved} to be proved)`;
			this.iconPath = {
				light: path.join(__dirname, "..", "..", "..", "icons", "svg-gray-circle.svg"),
				dark: path.join(__dirname, "..", "..", "..", "icons", "svg-white-circle.svg")
			};
		}
		this.collapsibleState = (this.theorems.length > 0) ?
			(nProved === nTheorems) ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.Expanded
				: TreeItemCollapsibleState.None;
	}
	updateStatus (desc: FormulaDescriptor): void {
		if (desc) {
			const candidates: FormulaItem[] = this.theorems.filter((elem: FormulaItem) => {
				return elem.getFormulaName() === desc.formulaName;
			});
			if (candidates && candidates.length === 1) {
				if (desc.status) {
					candidates[0].setStatus(desc.status);
					this.refreshLabel();
				}
			} else {
				const formulaType: string = (desc.isTcc) ? "tcc" : "theorem"
				this.theorems.push(new FormulaItem(formulaType, desc));
				this.refreshLabel();
			} 
		}
	}
	getTotal (): number {
		return this.theorems.length;
	}
}
export class FormulaItem extends TreeItem {
	contextValue: string = "formula";

	protected contextFolder: string;
	protected fileName: string;
	protected fileExtension: string;
	protected theoryName: string;
	protected formulaName: string;

	protected position: Position;
	protected status: ProofStatus;

	constructor(typeName: string, desc: FormulaDescriptor) {
		super(typeName, TreeItemCollapsibleState.None);
		this.contextValue = typeName;
		this.fileName = desc.fileName;
		this.fileExtension = desc.fileExtension;
		this.theoryName = desc.theoryName;
		this.formulaName = desc.formulaName;
		this.position = new Position (desc.position.line, desc.position.character);
		this.status = desc.status;
		this.contextFolder = desc.contextFolder;
		// const range: Range = new Range(
		// 	new Position(desc.position.line - 1, 0),
		// 	new Position(desc.position.line, 0)
		// );
		this.refreshLabel();
		this.command = {
			title: "Formula selected",
			command: "explorer.theorem-selected-event",
			arguments: [ desc ]
		};
	}
	getPosition(): Position { return this.position; }
	getFileName(): string { return this.fileName; }
	getFileExtension(): string { return this.fileExtension; }
	getTheoryName(): string { return this.theoryName; }
	getFormulaName(): string { return this.formulaName; }
	getContextFolder(): string { return this.contextFolder; }
	setStatus (status: ProofStatus) {
		this.status = status;
		this.refreshLabel();
	}
	getStatus (): ProofStatus {
		return this.status;
	}
	protected refreshLabel() {
		this.status = this.status || "unchecked"; //'\u{2705}'
		this.status = this.status.startsWith("proved") ? "proved" : this.status;
		// this.label = `${utils.getIcon(this.status)} ${this.formulaName}  (${this.status})`;
		this.label = `${this.formulaName}  (${this.status})`;
		const icon: string = utils.getIcon(this.status);
		this.iconPath = (icon === utils.icons.checkmark) ? {
			light: path.join(__dirname, "..", "..", "..", "icons", "svg-checkmark.svg"),
			dark: path.join(__dirname, "..", "..", "..", "icons", "svg-checkmark.svg")
		} : (icon === utils.icons.bang) ? {
			light: path.join(__dirname, "..", "..", "..", "icons", "svg-exclamation-mark.svg"),
			dark: path.join(__dirname, "..", "..", "..", "icons", "svg-exclamation-mark.svg")
		} : (icon === utils.icons.snowflake) ? {
			light: path.join(__dirname, "..", "..", "..", "icons", "svg-snowflake.svg"),
			dark: path.join(__dirname, "..", "..", "..", "icons", "svg-snowflake.svg")
		} : (icon === utils.icons.sparkles) ? {
			light: path.join(__dirname, "..", "..", "..", "icons", "svg-sparkles.svg"),
			dark: path.join(__dirname, "..", "..", "..", "icons", "svg-sparkles.svg")
		} : (icon === utils.icons.whitecircle) ? {
			light: path.join(__dirname, "..", "..", "..", "icons", "svg-gray-circle.svg"),
			dark: path.join(__dirname, "..", "..", "..", "icons", "svg-white-circle.svg")
		} : null;
	}
}
//-- overviews
class TheoremsOverviewItem extends FormulaOverviewItem {
	contextValue: string = "theorems-overview";
	constructor(desc: TheoryDescriptor) {
		super("theorems-overview", desc);
	}
}
export class TccsOverviewItem extends FormulaOverviewItem {
	contextValue: string = "tccs-overview";
	constructor(desc: TheoryDescriptor) {
		super("tccs-overview", desc);
		this.refreshLabel();
	}
	// @overrides
	updateStatus (desc: FormulaDescriptor): void {
		super.updateStatus(desc);
	}
	// @overrides
	protected refreshLabel () {
		if (this.getTotal() > 0) {
			super.refreshLabel();
		} else {
			this.label = "No TCCs";
		}
	}
	setTccs (desc: FormulaDescriptor[]): void {
		this.theorems = [];
		if (desc && desc.length) {
			for (let i = 0; i < desc.length; i++) {
				if (desc[i].formulaName) {
					this.updateStatus(desc[i]);
				}
			}
		}
	}
}
class TheoriesOverviewItem extends TreeItem {
	contextValue = "theories-overview";
	theories: TheoryItem[] = [];
	constructor (desc?: TheoryDescriptor[]) {
		super("theories-overview", TreeItemCollapsibleState.Expanded);
		this.theories = [];
		this.updateTheories(desc);
	}
	updateTheories (desc: TheoryDescriptor[], opt?: { tccDescriptor?: boolean }) {
		if (desc) {
			opt = opt || {};
			if (opt.tccDescriptor) {
				// the descriptor contains only tccs, don't touch the theorems
				for (let i = 0; i < desc.length; i++) {
					const candidates: TheoryItem[] = this.theories.filter((item: TheoryItem) => {
						return item.contextFolder === desc[i].contextFolder && item.fileName === desc[i].fileName
							&& item.fileExtension === desc[i].fileExtension && item.theoryName === desc[i].theoryName;
					});
					if (candidates && candidates.length === 1) {
						candidates[0].setTccs(desc[i].theorems);
					} else {
						console.warn(`[workspace-explorer] Warning: could not find theory item for `, desc);
					}
				}
			} else {
				const theories: TheoryItem[] = [];
				for (let i = 0; i < desc.length; i++) {
					const tdesc: TheoryDescriptor = desc[i];
					// create a new item only if the item does not already exist in the tree view
					// this is useful, e.g., to retain the list of tccs when updating theorems
					let theoryItem: TheoryItem = this.getTheoryItem(tdesc.theoryName);
					if (!theoryItem) {
						theoryItem = new TheoryItem(tdesc, TreeItemCollapsibleState.Expanded);
					}
					for (let i = 0; i < tdesc.theorems.length; i++) {
						const formula: FormulaDescriptor = tdesc.theorems[i];
						if (formula.isTcc) {
							theoryItem.updateTcc(formula);
						} else {
							theoryItem.updateFormula(formula);
						}
					}
					theoryItem.refreshLabel();
					theories.push(theoryItem);
				}
				this.theories = theories;
			}
		}
	}
	// /**
	//  * Internal function, computes the difference between two arrays of theory items.
	//  * This is used when updating theories, to keep the collapsiblestate.
	//  */
	// protected diff (v1: TheoryItem[], v2: TheoryItem[]): TheoryItem[] {
	// 	if (!v1 || v1.length === 0) { return []; }
	// 	if (!v2 || v2.length === 0) { return v1; }
	// 	const res: TheoryItem[] = v1.filter((item: TheoryItem) => {
	// 		return !v2.some((elem) => {
	// 			return elem.theoryName === item.theoryName;
	// 		});
	// 	});
	// 	return res;
	// }

	getChildren (): TreeItem[] {
		return this.theories;
	}
	getTheoryItem (theoryName: string): TheoryItem {
		if (this.theories) {
			let candidates: TheoryItem[] = this.theories.filter((item: TheoryItem) => {
				return item.theoryName === theoryName;
			});
			if (candidates && candidates.length === 1) {
				return candidates[0];
			}
		}
		return null;
	}
	updateFormula (desc: FormulaDescriptor): void {
		const candidates: TheoryItem[] = this.theories.filter((item: TheoryItem) => {
			return item.contextFolder === desc.contextFolder && item.fileName === desc.fileName
				&& item.fileExtension === desc.fileExtension && item.theoryName === desc.theoryName;
		});
		if (candidates && candidates.length === 1) {
			candidates[0].updateFormula(desc);
		}
	}
	sort (): void {
		this.theories = this.theories.sort((a: TheoryItem, b: TheoryItem): number => {
			return (a.theoryName > b.theoryName) ? 1 : -1;
		});
	}
}
class PvsFilesOverviewItem extends OverviewItem {
	contextValue = "pvs-files-overview";
	files: PvsFileItem[] = [];
	constructor(desc: PvsContextDescriptor) {
		super("pvs-files-overview", desc, TreeItemCollapsibleState.Expanded);
		this.files = [];
		this.updateContextFolder(desc);
	}
	getChildren (): TreeItem[] {
		let children: TreeItem[] = [];
		for (let i = 0; i < this.files.length; i++) {
			children = children.concat(this.files[i].getChildren());
		}
		return children;
	}
	getFileItem (desc: { contextFolder: string, fileName: string, fileExtension: string }): PvsFileItem {
		if (desc) {
			for (let i = 0; i < this.files.length; i++) {
				if (this.files[i].contextFolder === desc.contextFolder
						&& this.files[i].fileName === desc.fileName) {
						// && this.files[i].fileExtension === desc.fileExtension) { -- we are ignoring the extension because .tccs are virtual files, we need to use .pvs files
					return this.files[i];
				}
			}
		}
		return null;
	}
	updateFormula (desc: FormulaDescriptor): void {
		if (desc) {
			const candidates: PvsFileItem[] = this.files.filter((item: PvsFileItem) => {
				return item.fileName === desc.fileName && item.fileExtension === desc.fileExtension
					&& item.contextFolder === desc.contextFolder;
			});
			if (candidates && candidates.length === 1) {
				candidates[0].updateFormula(desc);
			}
		}
	}
	sort (): void {
		this.files = this.files.sort((a: PvsFileItem, b: PvsFileItem): number => {
			return (a.fileName > b.fileName) ? 1 : -1;
		});
		for (let i = 0; i < this.files.length; i++) {
			this.files[i].sort();
		}
	}
	updateContextFolder (desc: PvsContextDescriptor, opt?: { tccDescriptor?: boolean }): void {
		opt = opt || {};
		if (opt.tccDescriptor) {
			const fnames: string[] = Object.keys(desc.fileDescriptors);
			for (let i = 0; i < fnames.length; i++) {
				const candidates: PvsFileItem[] = this.files.filter((item: PvsFileItem) => {
					return fnames[i] === fsUtils.desc2fname(item);
				});
				if (candidates && candidates.length === 1) {
					candidates[0].updateFileDescriptor(desc.fileDescriptors[fnames[i]], opt);	
				} else {
					console.warn(`[workspace-explorer] Warning: could not find tree item for `, desc);
				}
			}
		} else {
			this.files = [];
			this.contextFolder = desc.contextFolder;
			if (desc.fileDescriptors) {
				const fnames: string[] = Object.keys(desc.fileDescriptors);
				for (let i = 0; i < fnames.length; i++) {
					const item: PvsFileItem = new PvsFileItem();
					item.updateFileDescriptor(desc.fileDescriptors[fnames[i]]);
					this.files.push(item);
				}
				// this.sort();
			}
		}
	}
}
export class WorkspaceOverviewItem extends OverviewItem {
	contextValue: string = "workspace-overview";

	protected path: string; // full path of the workspace
	protected pvsFilesOverview: PvsFilesOverviewItem;

	constructor(desc: PvsContextDescriptor) {
		super("workspace-overview", desc, TreeItemCollapsibleState.Expanded);
		this.pvsFilesOverview = new PvsFilesOverviewItem(desc);
		this.command = {
			title: "Workspace selected",
			command: "explorer.didSelectWorkspaceOverview",
			arguments: [ desc ]
		};
		this.refreshLabel();
	}
	protected refreshLabel (): void {
		// const n: number = (this.pvsFilesOverview && this.pvsFilesOverview.files) ? this.pvsFilesOverview.files.length : 0;
		// this.label = fsUtils.getContextFolderName(this.contextFolder) + ` (${n} pvs files)`;
		this.label = fsUtils.getContextFolderName(this.contextFolder);
		this.path = this.contextFolder;
		this.tooltip = this.path;
	}
	// setContextFolder (contextFolder: string) {
	// 	if (this.contextFolder !== contextFolder) {
	// 		this.contextFolder = contextFolder;
	// 		this.updateLabel();
	// 	}
	// }
	getFileItem (desc: { contextFolder: string, fileName: string, fileExtension: string }): PvsFileItem {
		if (this.pvsFilesOverview) {
			return this.pvsFilesOverview.getFileItem(desc);
		}
		return null;
	}
	getTheoryItem (desc: { contextFolder: string, fileName: string, fileExtension: string, theoryName: string }): TheoryItem {
		const fileItem: PvsFileItem = this.getFileItem(desc);
		if (fileItem) {
			return fileItem.getTheoryItem(desc);
		}
		return null;
	}
	getChildren (): TreeItem[] {
		return this.pvsFilesOverview.getChildren();
	}
	updateFormula (desc: FormulaDescriptor): void {
		this.pvsFilesOverview.updateFormula(desc);
	}
	sort (): void {
		this.pvsFilesOverview.sort();
	}
	updateContextFolder (desc: PvsContextDescriptor, opt?: { tccDescriptor?: boolean, force?: boolean }): void {
		opt = opt || {};
		// if (desc && (desc.contextFolder !== this.contextFolder || opt.force)) {
			this.contextFolder = desc.contextFolder;
			this.refreshLabel();
			this.pvsFilesOverview.updateContextFolder(desc, opt);
		// }
	}
}
//-- Items
// class TheoremItem extends FormulaItem {
// 	constructor(desc: FormulaDescriptor) {
// 		super("theorem", desc);
// 	}
// }
// class TccItem extends FormulaItem {
// 	constructor(desc: FormulaDescriptor) {
// 		super("tcc", desc);
// 	}
// }


/**
 * Data provider for PVS Explorer view
 */
export class VSCodePvsWorkspaceExplorer implements TreeDataProvider<TreeItem> {
	/**
	 * Events for updating the tree structure
	 */
	protected _onDidChangeTreeData: EventEmitter<TreeItem> = new EventEmitter<TreeItem>();
	readonly onDidChangeTreeData: Event<TreeItem> = this._onDidChangeTreeData.event;

	/**
	 * Language client for communicating with the server
	 */
	protected client: LanguageClient;
	protected proofExplorer: VSCodePvsProofExplorer;

	/**
	 * Name of the view associated with the data provider
	 */
	protected providerView: string;
	
	protected view: TreeView<TreeItem>;
	protected root: WorkspaceOverviewItem;
	protected loading: LoadingItem = new LoadingItem();

	protected filterOnTypeActive: boolean = false;

	/**
	 * Returns the full path of the pvs executable
	 */
	protected getPvsPath (): string {
		return vscodeUtils.getConfiguration("pvs.path");
	}

	/**
	 * Returns the full path of the current workspace folder
	 */
	getCurrentWorkspace (): string {
		if (this.root) {
			return this.root.getContextFolder();
		}
		return null;
	}

	/**
	 * Opens a pvs file in the editor and adds the containing folder in file explorer
	 */
	async openPvsFile (): Promise<void> {
		return await vscodeUtils.openPvsFile();
	}
	/**
	 * Opens a context folder and adds it to file explorer
	 */
	async openWorkspace (): Promise<void> {
		return await vscodeUtils.openWorkspace();
	}
	/**
	 * Opens a pvs file in the editor and adds the containing folder in file explorer
	 */
	async openPvsFileOrFolder (): Promise<string | null> {
		const contextFolder: string = await vscodeUtils.openPvsFileOrWorkspace();
		if (contextFolder) {
			return this.client.sendRequest(serverRequest.getContextDescriptor, { contextFolder })
		}
		return null;
	}
	/**
	 * Creates a new pvs file in the current workspace folder
	 */
	async newPvsFile (): Promise<void> {
		const fileName: string = await window.showInputBox({
			prompt: `Please enter PVS file name`,
			placeHolder: ``,
			value: ``,
			ignoreFocusOut: true 
		});
		if (fileName) {
			const theoryName = fsUtils.getFileName(fileName); // this will remove the extension, if any has been specified in the dialog
			const contextFolder: string = this.getCurrentWorkspace() || workspace.rootPath;
			const fname: string = path.join(contextFolder, `${theoryName}.pvs`);
			const uri: Uri = Uri.parse(`file://${fname}`, true);

			let stats: FileStat = null;
			try {
				stats = await workspace.fs.stat(uri);
			} catch (fileNotFound) {
				window.showWarningMessage(`Could not create ${theoryName}.pvs (file already exists in current workspace). Please choose a different file name.`);
			} finally {
				if (!stats) {
					const content: string = utils.makeEmptyTheory(theoryName);
					const edit: WorkspaceEdit = new WorkspaceEdit();

					edit.createFile(uri, { overwrite: false, ignoreIfExists: true });

					edit.insert(uri, new Position(0, 0), content);
					await workspace.applyEdit(edit);	
				}
				const editors: TextEditor[] = window.visibleTextEditors.filter((editor: TextEditor) => {
					return editor.document.fileName === fname;
				});
				const fileAlreadyOpen: boolean = (editors && editors.length > 0);
				const viewColumn: number = fileAlreadyOpen ? editors[0].viewColumn : ViewColumn.One;
				await window.showTextDocument(uri, { preserveFocus: true, preview: true, viewColumn });

			}
			// const theoryName = fsUtils.getFileName(fileName); // this will remove the extension
			// const contextFolder: string = this.getCurrentWorkspace() || workspace.rootPath;
			// const fname: string = path.join(contextFolder, `${theoryName}.pvs`);
			// const file: Uri = Uri.parse(`untitled:${theoryName}.pvs`);
			// const edit = new WorkspaceEdit();
			// const content: string = utils.makeEmptyTheory(theoryName);
			// edit.insert(file, new Position(0, 0), content);
			// const success: boolean = await workspace.applyEdit(edit);
			// if (success) {
			// 	const document: TextDocument = await workspace.openTextDocument(file);
			// 	window.showTextDocument(document, ViewColumn.Beside, true);
			// } else {
			// 	window.showInformationMessage(`Error: Unable to create file ${fname}`);
			// }
		}
	}
	/**
	 * Removes .prlite files, .pvscontext, pvsbin in all folders open in explorer
	 */
	async cleanPvsWorkspace (): Promise<void> {
		// const yesno: string[] = [ "Yes", "No" ];
		// const msg: string = `Remove all temporary PVS files?`
		// const ans: string = await window.showInformationMessage(msg, { modal: true }, yesno[0]);
		// if (ans === yesno[0]) {
			return await vscodeUtils.cleanPvsWorkspace();
		// }
	}
	/**
	 * @constructor
	 * @param client Language client 
	 * @param providerView VSCode view served by the data provider
	 */
	constructor(client: LanguageClient, proofExplorer: VSCodePvsProofExplorer, providerView: string) {
		this.client = client;
		this.providerView = providerView;
		this.proofExplorer = proofExplorer;
		// register tree view.
		// use window.createTreeView instead of window.registerDataProvider -- this allows to perform UI operations programatically. 
		// window.registerTreeDataProvider(this.providerView, this);
		this.view = window.createTreeView(this.providerView, { treeDataProvider: this, showCollapseAll: true });
	}

	getClient (): LanguageClient {
		return this.client;
	}

	// setContextFolder (context: string): void {
	// 	if (this.root) {
	// 		this.root.setContextFolder(context);
	// 	} else {
	// 		console.error(`[workspace-explorer] Error: root node is null`);
	// 	}
	// }

	updateFormula (desc: FormulaDescriptor): void {
		if (desc) {
			this.root.updateFormula(desc);
		}
	}

	updateContextFolder (desc: PvsContextDescriptor, opt?: { tccDescriptor?: boolean }): void {
		if (desc) {
			if (this.root) {
				this.root.updateContextFolder(desc, opt);
			} else {
				this.root = new WorkspaceOverviewItem(desc);
			}
		} else {
			this.root = null;
		}
		this.refreshView();
	}
	/**
	 * Force refresh of the tree view
	 */
	refreshView(): void {
		this._onDidChangeTreeData.fire();
	}

	// event dispatcher invokes this function with the command vscode-pvs.prove-theory
	async proveTheoryWithProgress (desc: PvsTheory, opt?: {
		tccsOnly?: boolean,
		useJprf?: boolean
	}): Promise<void> {
		if (desc && desc.theoryName) {
			opt = opt || {};
			// show dialog with progress
			await window.withProgress({
				location: ProgressLocation.Notification,
				cancellable: true
			}, async (progress, token) => {
				// show initial dialog with spinning progress
				const message: string = (opt.tccsOnly) ? `Preparing to prove TCCs in theory ${desc.theoryName}` : `Preparing to prove theorems in theory ${desc.theoryName}`;
				progress.report({ increment: -1, message });

				const formulas: PvsFormula[] = (opt.tccsOnly) ? await this.getTccs(desc) : await this.getTheorems(desc);

				progress.report({ increment: -1, message });
				// update the dialog
				return new Promise(async (resolve, reject) => {
					let stop: boolean = false;
					commands.executeCommand('setContext', 'autorun', true);
					// show output panel for feedback
					// commands.executeCommand("workbench.action.output.toggleOutput", true);
					token.onCancellationRequested(async () => {
						// stop loop
						stop = true;
						// stop proof explorer
						commands.executeCommand("vscode-pvs.interrupt-and-quit-prover");
						commands.executeCommand('setContext', 'autorun', false);
						// dispose of the dialog
						resolve(null);
					});
					// create one summary for each theory
					const summary: { total: number, tccsOnly?: boolean, theoryName: string, theorems: { theoryName: string, formulaName: string, status: ProofStatus, ms: number }[]} = {
						theoryName: desc.theoryName,
						theorems: [],
						tccsOnly: opt.tccsOnly,
						total: (formulas) ? formulas.length : 0
					};
					if (formulas && formulas.length) {
						for (let i = 0; i < formulas.length && !stop; i ++) {
							const theoryName: string = formulas[i].theoryName;
							const formulaName: string = formulas[i].formulaName;
							const message: string = (opt.tccsOnly) ? `Discharging proof obligations in theory ${theoryName} (${i + 1}/${formulas.length}) '${formulaName}'`
								: `Re-running proofs in theory ${theoryName} (${i + 1}/${formulas.length}) '${formulaName}'`
							if (formulas.length > 1) {
								progress.report({
									increment: 1 / formulas.length * 100, // all increments must add up to 100
									message
								});
							}
							const start: number = new Date().getTime();

							const status: ProofStatus = await new Promise((resolve, reject) => {
								const autorunRequest: string = (opt.useJprf) ? serverRequest.autorunFormulaFromJprf : serverRequest.autorunFormula;
								this.client.sendRequest(autorunRequest, {
									contextFolder: formulas[i].contextFolder,
									fileName: formulas[i].fileName,
									fileExtension: formulas[i].fileExtension,
									theoryName: formulas[i].theoryName,
									formulaName
								});
								this.client.onRequest(serverEvent.autorunFormulaResponse, (desc: { status: ProofStatus, error?: string }) => {
									if (desc && desc.error) {
										vscodeUtils.showErrorMessage(desc.error);
									}
									setTimeout(() => {
										// this timeout gives time to the front end to refresh the content
										resolve(desc.status);
									}, 250);
								});
							});

							const ms: number = new Date().getTime() - start;
							summary.theorems.push({ theoryName, formulaName, status, ms });
						}
					}
					commands.executeCommand('setContext', 'autorun', false);
					this.client.sendRequest(serverRequest.getContextDescriptor, desc);
					this.client.sendRequest(serverRequest.generateSummary, {
						contextFolder: desc.contextFolder,
						fileName: desc.fileName,
						fileExtension: desc.fileExtension,
						theoryName: desc.theoryName,
						content: utils.makeProofSummary(summary)
					});
					resolve();
				});
			});
		}
	}

	async getTheorems (desc: PvsTheory): Promise<PvsFormula[]> {
		return new Promise((resolve, reject) => {
			this.client.sendRequest(serverRequest.getTheorems, desc);
			this.client.onRequest(serverEvent.getTheoremsResponse, (response: { theorems: PvsFormula[], error?: string }) => {
				if (response && response.error) {
					vscodeUtils.showErrorMessage(response.error);
					vscodeUtils.showProblemsPanel();
				}
				return response ? resolve(response.theorems) : resolve(null);
			});
		});
	}

	async getTccs (desc: PvsTheory): Promise<PvsFormula[]> {
		return new Promise((resolve, reject) => {
			this.client.sendRequest(serverRequest.getTccs, desc);
			this.client.onRequest(serverEvent.getTccsResponse, (response: { theorems: PvsFormula[], error?: string }) => {
				if (response && response.error) {
					vscodeUtils.showErrorMessage(response.error);
					vscodeUtils.showProblemsPanel();
				}
				return response ? resolve(response.theorems) : resolve(null);
			});
		});
	}

	async getImportChainTheorems (desc: PvsTheory): Promise<PvsFormula[]> {
		return new Promise((resolve, reject) => {
			this.client.sendRequest(serverRequest.getImportChainTheorems, desc);
			this.client.onRequest(serverEvent.getImportChainTheoremsResponse, (response: { theorems: PvsFormula[] }) => {
				return response ? resolve(response.theorems) : resolve(null);
			});
		});
	}

	async proveImportChainWithProgress (desc: PvsTheory, opt?: { useJprf?: boolean }): Promise<void> {
		if (desc && desc.theoryName) {
			opt = opt || {};
			// show dialog with progress
			await window.withProgress({
				location: ProgressLocation.Notification,
				cancellable: true
			}, async (progress, token) => {
				// show initial dialog with spinning progress
				const message: string = `Resolving importchain for theory ${desc.theoryName}`;
				progress.report({ increment: -1, message });

				const formulas: PvsFormula[] = await this.getImportChainTheorems(desc);

				if (formulas && formulas.length) {
					// update the dialog
					return new Promise(async (resolve, reject) => {
						let stop: boolean = false;
						commands.executeCommand('setContext', 'autorun', true);
						// show output panel for feedback
						// commands.executeCommand("workbench.action.output.toggleOutput", true);
						token.onCancellationRequested(async () => {
							// stop loop
							stop = true;
							// stop proof explorer
							commands.executeCommand("vscode-pvs.interrupt-and-quit-prover");
							commands.executeCommand('setContext', 'autorun', false);
							// dispose of the dialog
							resolve(null);
						});
						// create one summary for each theory
						const summary: { total: number, tccsOnly?: boolean, theoryName: string, theorems: { theoryName: string, formulaName: string, status: ProofStatus, ms: number }[]} = {
							theoryName: desc.theoryName,
							theorems: [],
							total: formulas.length
						};
						for (let i = 0; i < formulas.length && !stop; i ++) {
							const theoryName: string = formulas[i].theoryName;
							const formulaName: string = formulas[i].formulaName;
							const message: string = `Re-running proofs in theory ${theoryName} (${i + 1}/${formulas.length}) '${formulaName}'`;
							if (formulas.length > 1) {
								progress.report({
									increment: 1 / formulas.length * 100, // all increments must add up to 100
									message
								});
							}
							const start: number = new Date().getTime();

							const status: ProofStatus = await new Promise((resolve, reject) => {
								const autorunRequest: string = opt.useJprf ? serverRequest.autorunFormulaFromJprf : serverRequest.autorunFormula;
								this.client.sendRequest(autorunRequest, {
									contextFolder: formulas[i].contextFolder,
									fileName: formulas[i].fileName,
									fileExtension: formulas[i].fileExtension,
									theoryName,
									formulaName
								});
								this.client.onRequest(serverEvent.autorunFormulaResponse, (status: ProofStatus) => {
									setTimeout(() => {
										// this timeout gives time to the front end to refresh the content
										resolve(status);
									}, 250);
								});
							});

							const ms: number = new Date().getTime() - start;
							summary.theorems.push({ theoryName, formulaName, status, ms });
						}
						this.client.sendRequest(serverRequest.getContextDescriptor, desc);
						this.client.sendRequest(serverRequest.generateSummary, {
							contextFolder: desc.contextFolder,
							fileName: desc.fileName,
							fileExtension: desc.fileExtension,
							theoryName: desc.theoryName,
							content: utils.makeProofSummary(summary)
						});
						
						commands.executeCommand('setContext', 'autorun', false);
						resolve();
					});
				} else {
					progress.report({
						increment: 100, // all increments must add up to 100
						message: "No formula to re-run"
					});
				}
			});
		}
	}

	async showProofSummary (desc: PvsTheory): Promise<void> {
		if (desc && desc.theoryName) {
			const summaryFile: PvsFile = {
				fileName: desc.fileName,
				fileExtension: ".summary",
				contextFolder: desc.contextFolder
			};
			const fname: string = fsUtils.desc2fname(summaryFile);

			// check if summary file exists and if it contains the summary for the requested theory
			const fileExists: boolean = await fsUtils.fileExists(fname);
			let theorySummaryExists: boolean = false;
			if (fileExists) {
				theorySummaryExists = await utils.containsSummary(fname, desc.theoryName);
			}

			// show the summary file if the summary exists, or generate the summary file
			if (theorySummaryExists) {
				vscodeUtils.showTextDocument(summaryFile);
			} else {
				const yesno: string[] = [ "Yes", "No" ];
				const msg: string = `Summary file has not been generated yet. Re-run all proofs in theory ${desc.theoryName}?`
				const ans: string = await window.showInformationMessage(msg, { modal: true }, yesno[0]);
				if (ans === yesno[0]) {
					commands.executeCommand("vscode-pvs.prove-theory", desc);
				}
			}
		}
	}


	/**
	 * Handler activation function
	 * @param context Client context 
	 */
	activate(context: ExtensionContext) {
		// all commands in the form vscode-pvs.xxxx are handled by VSCodeEventsDispatcher

		// click on a tcc formula to open the file and highlight the tcc name in the theory
		context.subscriptions.push(commands.registerCommand('explorer.tcc-selected-event', async (uri: Uri, range: Range) => {
			// window.showInformationMessage("theory selected: " + theoryName + " " + fileName + "(" + position.line + ", " + position.character + ")");
			window.showTextDocument(uri, {
				preserveFocus: true, 
				preview: true,
				viewColumn: ViewColumn.Beside,
				selection: range
			});
		}));

		// click on a theorem to open the file and highlight the theorem in the theory
		context.subscriptions.push(commands.registerCommand('explorer.theorem-selected-event', async (desc: FormulaDescriptor) => {
			vscodeUtils.showTextDocument(desc, {
				selection: new Range(
					new Position(desc.position.line - 1, 0), // - 1 is because lines in vscode start from 0
					new Position(desc.position.line - 1, 1000) // highlight entire line
				)
			});
		}))
		
		// click on a theory name to open the file and highlight the theory name in the file
		context.subscriptions.push(commands.registerCommand('explorer.didSelectTheory', async (desc: TheoryDescriptor) => {
			vscodeUtils.showTextDocument(desc, {
				selection: new Range(
					new Position(desc.position.line - 1, 0), // - 1 is because lines in vscode start from 0
					new Position(desc.position.line - 1, 1000) // highlight entire line
				)
			});
		}));

		// click on the workspace enables search by type in the tree view
		context.subscriptions.push(commands.registerCommand('explorer.didSelectWorkspaceOverview', async (desc: PvsContextDescriptor) => {
			if (!this.filterOnTypeActive) { // this will capture future attempt to toggle the filter -- there's no other way to keep this filter on
				this.filterOnTypeActive = true;
				commands.executeCommand('list.toggleFilterOnType', true);
			}
		}));
	}

	/**
	 * Returns the list of theories defined in the active pvs file
	 * @param element Element clicked by the user 
	 */
	getChildren(element: TreeItem): Thenable<TreeItem[] | null> {
		if (element) {
			let children: TreeItem[] = null;
			if (element.contextValue === "workspace-overview") {
				children = this.root.getChildren();
			} else if (element.contextValue === "pvs-files-overview") {
				children = (<PvsFilesOverviewItem> element).getChildren();
			} else if (element.contextValue === "pvs-file") {
				children = (<PvsFileItem> element).getChildren();
			} else if (element.contextValue === "theory") {
				// pvs theory
				const desc: TheoryItem = <TheoryItem> element;
				const nTccs: number = desc.getTccsOverview().getTotal();
				if (nTccs > 0) {
					children = [].concat(desc.getTheoremsOverview().getChildren()).concat([ <TreeItem> desc.getTccsOverview() ]);
				} else {
					children = desc.getTheoremsOverview().getChildren();
				}
			} else if (element.contextValue === "tccs-overview") {
				// tcc list
				const desc: TccsOverviewItem = <TccsOverviewItem> element;
				children = desc.getChildren();
			} else if (element.contextValue === "tcc") {
				// console.log('tcc');
			} else if (element.contextValue === "theorem") {
				// console.log('theorem');
			} else if (element.contextValue === "theorems-overview") {
				const desc: TheoremsOverviewItem = <TheoremsOverviewItem> element;
				children = desc.getChildren();
			} else if (element.contextValue === "theories-overview") {
				children = (<TheoriesOverviewItem> element).getChildren();
			}
			return Promise.resolve(children);
		}
		// root node: show context
		if (this.root) {
			// this.loading.stop();
			return Promise.resolve([ this.root ]);
		} 
		// else {
		// 	this.loading.start().then(() => { this.refreshView(); });
		// 	return Promise.resolve([ this.loading ])
		// }
		return Promise.resolve(null);
	}

	getTreeItem(element: TreeItem): TreeItem {
		return element;
	}

}
