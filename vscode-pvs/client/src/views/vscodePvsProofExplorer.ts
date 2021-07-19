/**
 * @module VSCodePvsProofExplorer
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
	TreeItem, Command, EventEmitter, Event, TreeDataProvider, TreeView
} from 'vscode';
import { LanguageClient } from 'vscode-languageclient';
import { 
	ProofNode, serverRequest, PvsVersionDescriptor, ProofDescriptor, ProofStatus, 
	serverEvent, PvsFormula, ProofNodeX, ProofNodeStatus, ProofEditCopyNode, 
	ProofEditDidCopyNode, ProofEditDidAppendNode, ProofEditPasteNode, 
	ProofExecForward, ProofExecBack, ProofExecFastForward, ProofExecRun, 
	ProofExecQuit, ProofEditCopyTree, ProofEditDidCopyTree, ProofEditPasteTree, 
	ProofEditDeleteNode, ProofEditTrimNode, ProofEditDeleteTree, ProofEditCutTree, 
	ProofEditCutNode, ProofEditAppendNode, ProofEditAppendBranch, ProofEditRenameNode, 
	ProofEditDidTrimNode, ProofEditDidDeleteNode, ProofEditDidCutNode, ProofEditDidCutTree, 
	ProofEditDidPasteTree, PvsProofCommand, ProofEditDidRenameNode, ProofEditDidActivateCursor, 
	ProofEditDidDeactivateCursor, ProofEditDidUpdateProofStatus, ProofExecDidUpdateSequent, 
	ProofEditTrimUnused, ServerMode, ProofEditExportProof, ProofExecOpenProof, 
	ProofExecStartNewProof, ProofExecQuitAndSave, ProofNodeType, ProofExecImportProof, 
	FileDescriptor, ProofExecRewind, ProofExecInterruptProver, SequentDescriptor, ProofEditSliceTree, ProofEditDidUpdateDirtyFlag 
} from '../common/serverInterface';
import * as fsUtils from '../common/fsUtils';
import { TreeStructure, NodeType, isGlassboxTactic, isPostponeCommand, isUndoCommand, formatSequent } from '../common/languageUtils';
import { findTheoryName, findFormulaName } from '../common/fsUtils';
import * as vscode from 'vscode';
import * as vscodeUtils from '../utils/vscode-utils';
import * as path from 'path';
import { VSCodePvsVizTree } from './vscodePvsProofTreeViz';
import Backbone = require('backbone');
import { YesNoCancel } from '../utils/vscode-utils';

// export interface TreeStructure {
//     id?: string,
//     name?: string,
//     status?: {
//         visited: boolean,
//         pending: boolean,
//         complete: boolean,
//         active: boolean
//     },
//     children?: TreeStructure[],
//     parent?: TreeStructure,
//     depth?: number, // distance from the root node. height = 0 for the root node
// 	height?: number, // greatest distance from any descendant. height = 0 for leaf nodes
// };

export enum ProofExplorerEvent {
	didStopExecution = "didStopExecution"
};

/**
 * TreeData provider for Proof Explorer
 */
export class VSCodePvsProofExplorer extends Backbone.Model implements TreeDataProvider<TreeItem> {
	protected pvsVersionDescriptor: PvsVersionDescriptor;

	protected pendingExecution: boolean = false; // indicates whether step() has been triggered and we need to wait for onStepExecuted before doing anything else

	/**
	 * Events for updating the tree structure
	 */
	protected _onDidChangeTreeData: EventEmitter<TreeItem> = new EventEmitter<TreeItem>();
	readonly onDidChangeTreeData: Event<TreeItem> = this._onDidChangeTreeData.event;

	/**
	 * Language client for communicating with the server
	 */
	protected client: LanguageClient;
	protected serverMode: ServerMode = "lisp";

	protected treeviz: VSCodePvsVizTree;

	/**
	 * Flag indicating whether the view is enabled
	 */
	protected enabled: boolean = false;

	/**
	 * Timer used to implement a delayed refresh of the view, useful to improve performance
	 */
	protected timer: NodeJS.Timer = null;
	protected tcounter: number = 0;
	readonly maxSkip: number = 32768;
	readonly maxTimer: number = 500; //ms

	// whether the proof is dirty and needs to be saved
	protected dirtyFlag: boolean = false;

	/**
	 * Information on the formula loaded in proof explorer
	 **/
	protected formula: PvsFormula;
	
	protected autorunFlag: boolean = false;
	protected autorunCallback: (status: ProofStatus) => void;

	protected filterOnTypeActive: boolean = false;

	/**
	 * Name of the view associated with the data provider
	 */
	protected providerView: string;
	protected view: TreeView<TreeItem>;

	/**
	 * Attributes for run-time management of the proof tree rendered in the view
	 */
	protected welcome: WelcomeScreen = new WelcomeScreen();
	protected loading: LoadingItem = new LoadingItem();

	/**
	 * Pointers to relevant nodes
	 */
	protected root: RootNode = null // the root of the tree
	protected ghostNode: GhostNode = null; // this is a floating node that follows activeNode. It is used during proof development, to signpost where the next proof command will be appended in the proof tree
	protected activeNode: ProofCommand | ProofBranch | GhostNode = null;

	/**
	 * Status flag, indicates whether we are running all proof commands, as opposed to stepping through the proof commands
	 */
	protected running: boolean = false;

	/**
	 * JSON representation of the proof script for the current proof.
	 * The representation is updated at the beginning of the proof session.
	 */
	protected proofDescriptor: ProofDescriptor;

	protected fft: { id: string, name: string } = null; // fast forward / rewind target

	protected searchCache: { [nodeId:string]: ProofItem } = {};

	/**
	 * Current proof state
	 */
	// protected proofState: SequentDescriptor;

	
	/**
	 * @constructor
	 * @param client Language client 
	 * @param providerView Name of the VSCode view linked to proof explorer
	 */
	constructor(client: LanguageClient, providerView: string) {
		super();
		this.client = client;
		this.providerView = providerView;

		// Register tree view; 
		// use window.createTreeView instead of window.registerDataProvider -- this allows to perform UI operations programatically. 
		// window.registerTreeDataProvider(this.providerView, this);
		this.view = window.createTreeView(this.providerView, { treeDataProvider: this });
		this.treeviz = new VSCodePvsVizTree();

		// install view handlers
		this.view.onDidChangeVisibility((evt: vscode.TreeViewVisibilityChangeEvent) => {
			if (evt?.visible) {
				// refresh the tree view
				this.refreshView({ force: true });
				// highlight active node
				// this.focusActiveNode();
				this.selectActiveNode();
			}
		});
	
	}

	/**
	 * Sets the dirty flag
	 */
	updateDirtyFlag (desc: ProofEditDidUpdateDirtyFlag): void {
		if (desc) {
			this.dirtyFlag = desc.flag;
		} else {
			console.log("[vscode-proof-explorer] Warning: dirty flag is null");
		}
	}

	/**
	 * Returns true if the proof is dirty
	 */
	 proofIsDirty (): boolean {
		return this.dirtyFlag;
	}

	/**
	 * Returns the name of the current proof
	 */
	getProofName (): string {
		return this.root?.name || "";
	}

	/**
	 * Updates server mode
	 */
	didUpdateServerMode (mode: ServerMode): void {
		this.serverMode = mode;
	}

	/**
	 * Executes all proof commands in the proof tree, starting from the active node.
	 * The execution stops either at the end of the proof tree, or when an anomaly 
	 * is detected in the proof tree (e.g,. the prover generates more goals than those 
	 * indicated in the proof tree)
	 */
	run (): void {
		this.running = true;
		vscode.commands.executeCommand('setContext', 'proof-explorer.running', true);
		if (this.serverMode === "in-checker") {
			// run entire proof
			const action: ProofExecRun = { action: "run" };
			this.client.sendRequest(serverRequest.proverCommand, action);
			vscode.commands.executeCommand("xterm.showFeedbackWhileExecuting", { cmd: "run-proof" });
		} else {
			commands.executeCommand("vscode-pvs.prove-formula", this.formula);
		}
	}

	fastForwardTo (resource: { id: string, name: string }): void {
		if (resource && this.serverMode === "in-checker") {
			this.running = true;
			vscode.commands.executeCommand('setContext', 'proof-explorer.running', true);
			// fast forward proof to a given proof command
			this.fft = { id: resource.id, name: resource.name };
			const action: ProofExecFastForward = { action: "fast-forward", selected: this.fft };
			console.log(`[vscode-proof-explorer] Fast forward to ${resource.name} (${resource.id})`);
			this.client.sendRequest(serverRequest.proverCommand, action);
		}
	}

	rewindTo (resource: { id: string, name: string }): void {
		if (resource && this.serverMode === "in-checker") {
			this.running = true;
			vscode.commands.executeCommand('setContext', 'proof-explorer.running', true);
			// rewind to a given proof command
			this.fft = { id: resource.id, name: resource.name };
			const action: ProofExecRewind = { action: "rewind", selected: this.fft };
			console.log(`[vscode-proof-explorer] Rewinding to ${resource.name} (${resource.id})`);
			this.client.sendRequest(serverRequest.proverCommand, action);
		}
	}

	/**
	 * Shows the proof tree
	 */
	showWebView (opt?: { recenter?: boolean }): void {
		const treeStructure: TreeStructure = this.getTreeStructure();
		this.treeviz?.renderView(treeStructure, this.formula, { reveal: true, ...opt });
	}

	/**
	 * Utility function, finds a node using the node id as search key
	 */
	protected findNode (id: string): ProofBranch {
		const findNodeAux = (id: string, node: ProofItem): ProofBranch | null => {
			if (node && node.nodeId === id) {
				this.searchCache[id] = node;
				return node;
			}
			for (let i = 0; i < node.children.length; i++) {
				const res: ProofItem = findNodeAux(id, node.children[i]);
				if (res) {
					return res;
				}
			}
			return null;
		}
		// return findNodeAux(id, this.root);
		return this.searchCache[id] || findNodeAux(id, this.root);
	}
	/**
	 * Places focus on the active node in the view.
	 */
	focusActiveNode (opt?: { force?: boolean }): void {
		if (this.activeNode) {
			this.revealNode({ id: this.activeNode.nodeId, name: this.activeNode.name }, opt);
			this.focusNode({ id: this.activeNode.nodeId, name: this.activeNode.name }, opt);
			if (opt?.force) {
				this.refreshView({ force: true });
			}
		} else {
			// empty proof -- try to focus the ghost node
			if (this.ghostNode?.isActive()) {
				this.running = false;
				this.fft = null;
				this.trigger(ProofExplorerEvent.didStopExecution);
				this.revealNode({ id: this.ghostNode.nodeId, name: this.ghostNode.name }, opt);
				this.focusNode({ id: this.ghostNode.nodeId, name: this.ghostNode.name }, opt);
				if (opt?.force) {
					this.refreshView({ force: true });
				}
			}
		}
	}
	/**
	 * Selects the active node in the view.
	 */
	selectActiveNode (opt?: { force?: boolean }): void {
		if (this.activeNode) {
			this.revealNode({ id: this.activeNode.nodeId, name: this.activeNode.name }, opt);
			this.selectNode({ id: this.activeNode.nodeId, name: this.activeNode.name }, opt);
			if (opt?.force) {
				this.refreshView({ force: true });
			}
		} else {
			// empty proof -- try to focus the ghost node
			if (this.ghostNode?.isActive()) {
				this.running = false;
				this.fft = null;
				this.trigger(ProofExplorerEvent.didStopExecution);
				this.revealNode({ id: this.ghostNode.nodeId, name: this.ghostNode.name }, opt);
				this.selectNode({ id: this.ghostNode.nodeId, name: this.ghostNode.name }, opt);
				if (opt?.force) {
					this.refreshView({ force: true });
				}
			}
		}
	}
	/**
	 * Reveals a node in the view.
	 */
	revealNode (desc: { id: string, name: string }, opt?: { force?: boolean }): void {
		if (desc && desc.id && (this.isVisible() || opt?.force)) {
			// there is something I don't understand in the APIs of TreeItem 
			// because I'm getting exceptions (node not found / element already registered)
			// when option 'select' is set to true.
			// Sometimes the exception occurs also with option 'expand'
			// if (desc.selected.isActive() === false) {
				let selected: ProofItem = this.findNode(desc.id);
				if (!selected && this.ghostNode?.isActive()) {
					selected = this.ghostNode;
					this.ghostNode.parent = this.ghostNode.parent || this.ghostNode.realNode;
					if (this.treeviz?.isVisible()) {
						this.treeviz?.renderView(this.getTreeStructure(), this.formula, { source: "did-reveal-node" });
					}
				}
				if (selected && selected.parent && !selected.parent.isComplete()) {
					this.view.reveal(selected, { expand: 2, select: true, focus: false }).then(() => {
					}, (error: any) => {
						// console.error(selected);
						// console.error(error);
					});
				}
			// }
		}
	}
	/**
	 * Expands a node in the view.
	 */
	expandNode (desc: { id: string, name: string }): void {
		if (desc && desc.id && this.isVisible()) {
			let selected: ProofItem = this.findNode(desc.id);
			// if (selected) {
			// 	selected.id = fsUtils.get_fresh_id(); // this is a workaround -- treeview updates the collapsible state only if the node has a new ID
			// 	selected.collapsibleState = TreeItemCollapsibleState.Expanded;
			// 	this.refreshView();
			// }
			if (selected && selected.parent) {
				this.view.reveal(selected, { expand: true, select: false, focus: false }).then(() => {
				}, (error: any) => {
					// console.error(selected);
					// console.error(error);
				});
			}
		}
	}
	/**
	 * Collapses a node in the view.
	 */
	collapseNode (desc: { id: string, name: string }): void {
		if (desc?.id && this.isVisible()) {
			const selected: ProofItem = this.findNode(desc.id);
			if (selected) {
				selected.id = fsUtils.get_fresh_id(); // this is a workaround -- treeview updates the collapsible state only if the node has a new ID
				selected.collapsibleState = TreeItemCollapsibleState.Collapsed;
				this.refreshView();
			}
		}
	}
	/**
	 * Folds (i.e., collapses) proved branches.
	 */
	foldProvedBranches (): void {
		const collapseAux = (node: ProofItem): void => {
			if (node) {
				if (node.isComplete() && node?.children?.length) {
					console.log(`[vscode-proof-explorer] Folding branch ${node.name}`);
					this.collapseNode({ id: node.nodeId , name: node.name });
				} else {
					for (let i = 0; i < node?.children?.length; i++) {
						collapseAux(node.children[i]);
					}
				}
			}
		}
		collapseAux(this.root);
	}
	/**
	 * Places the focus on a node in the view.
	 */
	focusNode (desc: { id: string, name: string }, opt?: { force?: boolean }): void {
		if (desc && desc.id && (this.isVisible() || opt?.force)) {
			let selected: ProofItem = this.findNode(desc.id);
			if (!selected && this.ghostNode.isActive()) {
				selected = this.ghostNode;
				this.ghostNode.parent = this.ghostNode.parent || this.ghostNode.realNode;
				this.running = false;
				this.fft = null;
				this.trigger(ProofExplorerEvent.didStopExecution);
			}
			if (selected && selected.parent) {
				this.view.reveal(selected, { expand: 2, select: true, focus: true }).then(() => {
				}, (error: any) => {
					console.error(selected);
					// console.error(error);
				});
			}
		}
	}
	/**
	 * Selects a node in the view.
	 */
	selectNode (desc: { id: string, name: string }, opt?: { force?: boolean }): void {
		if (desc && desc.id && (this.isVisible() || opt?.force)) {
			let selected: ProofItem = this.findNode(desc.id);
			if (!selected && this.ghostNode.isActive()) {
				selected = this.ghostNode;
				this.ghostNode.parent = this.ghostNode.parent || this.ghostNode.realNode;
			}
			if (selected && selected.parent) {
				this.view.reveal(selected, { expand: 2, select: true, focus: false }).then(() => {
				}, (error: any) => {
					console.error(selected);
					// console.error(error);
				});

			}
		}
	}
	/**
	 * Handler executed after stopping the execution of a proof -- resets proof-explorer.running flag
	 */
	didStopRunning (): void {
		this.running = false;
		vscode.commands.executeCommand('setContext', 'proof-explorer.running', false);
		// select active node
		// this.focusActiveNode();
		this.selectActiveNode();
	}
	/**
	 * Handler for copy operations --- the selected node is copied to the clipboard 
	 * (i.e., the clipboard will store a copy of the selected node)
	 * @param desc Descriptor of the selected node.
	 */
	didCopyNode (desc: ProofEditDidCopyNode): void {
		if (desc && desc.selected) {
			// copy node to system clipboard & show feedback
			vscodeUtils.copyToClipboard(desc.selected.name, { msg: `${desc.selected.name} copied to clipboard` });
			// set vscode context variable proof-explorer.clipboard-contains-node to true
			vscode.commands.executeCommand('setContext', 'proof-explorer.clipboard-contains-node', true);
		}
	}
	/**
	 * Handler for copy-tree operations -- the tree rooted at the selected node is copied to the clipboard, 
	 * and all the siblings below the selected node (i.e., the clipboard will store a copy of the tree rooted 
	 * at the selected node)
	 * @param desc Descriptor of the selected node.
	 */
	didCopyTree (desc: ProofEditDidCopyTree): void {
		if (desc && desc.selected) {
			// copy node to system clipboard & show feedback
			vscodeUtils.copyToClipboard(desc.clipboard, { msg: `Subtree rooted in ${desc.selected.name} copied to clipboard` });
			// set vscode context variable proof-explorer.clipboard-contains-tree and clipboard-contains-node to true
			commands.executeCommand('setContext', 'proof-explorer.clipboard-contains-tree', true);
			commands.executeCommand('setContext', 'proof-explorer.clipboard-contains-node', true);
		}
	}
	/**
	 * Handler for cut operations -- copies to the clipboard and to the sketchpad the node that was cut 
	 */
	didCutNode (desc: ProofEditDidCutNode): void {
		if (desc && desc.selected) {
			// copy node to system clipboard
			vscodeUtils.copyToClipboard(desc.selected.name);
			// set vscode context variable proof-explorer.clipboard-contains-tree and clipboard-contains-node to true
			commands.executeCommand('setContext', 'proof-explorer.clipboard-contains-node', true);				
			this.refreshView({ source: "did-cut-node" });
			// append elems to sketchpad
			const items: ProofItem[] = this.convertNodeX2ProofItem(desc.elem);
			let sketchpadItems: ProofItem[] = [];
			sketchpadItems = sketchpadItems.concat(items);
			for (let i = 0; i < items?.length; i++) {
				delete this.searchCache[items[i].nodeId];
			}
			commands.executeCommand("proof-mate.update-sketchpad", { items: sketchpadItems });
		}
	}
	/**
	 * Handler for cut-tree operations -- copies to the clipboard and to the sketchpad the tree that was cut 
	 */
	didCutTree (desc: ProofEditDidCutTree): void {
		if (desc && desc.selected) {
			// copy node to system clipboard
			vscodeUtils.copyToClipboard(desc.clipboard);			
			// set vscode context variable proof-explorer.clipboard-contains-tree and clipboard-contains-node to true
			commands.executeCommand('setContext', 'proof-explorer.clipboard-contains-tree', true);
			commands.executeCommand('setContext', 'proof-explorer.clipboard-contains-node', true);
			// refresh view
			this.refreshView({ source: "did-cut-tree" });
			// append elems to sketchpad
			let sketchpadItems: ProofItem[] = [];
			for (let i = 0; i < desc.elems.length; i++) {
				const items: ProofItem[] = this.convertNodeX2ProofItem(desc.elems[i]);
				sketchpadItems = sketchpadItems.concat(items);
			}
			commands.executeCommand("proof-mate.update-sketchpad", { items: sketchpadItems });
		}
	}
	/**
	 * Handler for paste-tree operations -- reveals the structure of the subtree pasted in proof-explorer
	 */
	didPasteTree (desc: ProofEditDidPasteTree): void {
		// the tree structure is automatically updated whenever a node is added to the proof tree (see did-append-node)
		if (desc && desc.selected) {
			this.revealNode(desc.selected)
		}
		this.refreshView({ source: "did-paste-tree"});
	}
	/**
	 * Handler for rename operations
	 */
	didRenameNode (desc: ProofEditDidRenameNode): void {
		if (desc && desc.selected && desc.newName) {
			const item: ProofItem = this.findNode(desc.selected.id);
			if (item) {
				item.rename(desc.newName);
				this.refreshView({ source: "did-rename-node" });
				if (this.treeviz?.isVisible()) {
					this.treeviz?.rename(desc.selected.id, desc.newName);
				}
			} else {
				console.warn(`[vscode-proof-explorer] Warning: could not find item ${desc.selected.name} necessary for proofEdit/renameNode (${desc.selected.id})`)
			}
		} else {
			console.warn(`[vscode-proof-explorer] Warning: unable to complete proofEdit/renameNode`);
		}
	}
	/**
	 * Handler for updating the tree view has become active
	 */
	didActivateCursor (desc: ProofEditDidActivateCursor): void {
		if (desc && desc.cursor) {
			const realNode: ProofItem = this.findNode(desc.cursor.parent);
			if (realNode) {
				this.ghostNode.realNode = realNode;
				this.ghostNode.parent = realNode;
				this.ghostNode.active();
				this.activeNode = null;
				this.refreshView({ source: "did-activate-cursor" });
			}
		} else {
			console.warn(`[vscode-proof-explorer] Warning: unable to complete proofEdit/activateCursor`)
		}
	}
	/**
	 * Handler for updating the tree view when the ghost node has become active
	 */
	didDeactivateCursor (desc: ProofEditDidDeactivateCursor): void {
		this.ghostNode.parent = null;
		this.ghostNode.notActive();
		this.refreshView({ source: "did-deactivate-cursor" });
	}
	/**
	 * Handler for proof status updates
	 */
	didUpdateProofStatus (desc: ProofEditDidUpdateProofStatus): void {
		if (this.root) {
			if (desc.proofStatus === "proved") {
				this.root.QED();
				// clear sketchpad
				commands.executeCommand("proof-mate.update-sketchpad", { items: [] });
				// clear running flag
				this.running = false;
				vscode.commands.executeCommand('setContext', 'proof-explorer.running', false);
			} else {
				this.root.pending();
				this.root.setProofStatus(desc.proofStatus);
			}
			this.refreshView({ source: "did-update-proof-status" });
		} else {
			console.warn(`[vscode-proof-explorer] Warning: could not update proof status (root node is null)`);
		}
	}

	/**
	 * Utility function, disables treeviz controls
	 */
	disableTreeVizControls (): void {
		this.treeviz?.disableControls();
	}

	/**
	 * Utility function, enables treeviz controls
	 */
	enableTreeVizControls (): void {
		this.treeviz?.enableControls();
	}

	/**
	 * Resets the view
	 */
	resetView (): void {
		this.root = null;
		this.ghostNode = null;
		this.activeNode = null;
		this.searchCache = {};
		this.refreshView({ source: "did-reset-view" });
	}

	/**
	 * Utility function, returns true if proof-explorer is re-running a proof
	 */
	isRunning (): boolean  {
		return this.running;
	}

	/**
	 * Handler for trim-node events
	 */
	didTrimNode (desc: ProofEditDidTrimNode): void {
		if (desc && desc.elems && desc.elems.length) {
			let sketchpadItems: ProofItem[] = [];
			for (let i = 0; i < desc.elems.length; i++) {
				const items: ProofItem[] = this.convertNodeX2ProofItem(desc.elems[i]);
				sketchpadItems = sketchpadItems.concat(items);
				delete this.searchCache[desc.elems[i].id];
			}
			this.refreshView({ source: "did-trim-node" });
			commands.executeCommand("proof-mate.update-sketchpad", { items: sketchpadItems });
		} else {
			console.warn(`[vscode-proof-explorer] Warning: unable to complete proofEdit/trimNode`);
		}
	}

	/**
	 * Handler for delete-node events
	 */
	didDeleteNode (desc: ProofEditDidDeleteNode): void {
		if (desc && desc.selected) {
			const item: ProofItem = this.findNode(desc.selected.id);
			if (item && item.parent) {
				item.parent.deleteChild(item);
				delete this.searchCache[desc.selected.id];
				this.refreshView({ source: "did-delete-node" });
				console.log(`[vscode-proof-explorer] Did delete ${desc.selected.name} (${desc.selected.id})`);
			} else {
				console.warn(`[vscode-proof-explorer] Warning: could not find item ${desc.selected.name} necessary for proofEdit/deleteNode (${desc.selected.id})`)
			}
		} else {
			console.warn(`[vscode-proof-explorer] Warning: unable to complete proofEdit/deleteNode`);
		}
	}

	/**
	 * Handler for append-node events
	 */
	didAppendNode (desc: ProofEditDidAppendNode): void {
		if (desc && desc.elem) {
			const parent: ProofItem = this.findNode(desc.elem.parent);
			if (parent) {
				const items: ProofItem[] = this.convertNodeX2ProofItem(desc.elem); // do not give the parent otherwise the node will be automatically appended by convertNodeX2ProofItem
				const children1: ProofItem[] = parent.children.slice(0, desc.position);
				const children2: ProofItem[] = parent.children.slice(desc.position);
				parent.children = children1.concat(items.map(item => {
					item.parent = parent;
					return item;
				})).concat(children2);
				parent.collapsibleState = TreeItemCollapsibleState.Expanded;
				this.refreshView({ source: "did-append-node" });
				console.log(`[vscode-proof-explorer] Did append ${desc.elem.name} (${desc.elem.id})`);
			} else {
				console.warn(`[vscode-proof-explorer] Warning: could not find parent ${desc.elem.parent} necessary for proofEdit/appendNode (${desc.elem.name})`)
			}
		} else {
			console.warn(`[vscode-proof-explorer] Warning: unable to complete proofEdit/appendNode`);
		}
	}
	/**
	 * Refresh tree views (explorer and external treeviz)
	 */
	refreshView (opt?: { force?: boolean, source?: string }): void {
		opt = opt || {};
		const refresh = () => {
			if (this.isVisible() || opt?.force) {
				this._onDidChangeTreeData.fire(null);
				this.selectActiveNode();
			}
			if (this.treeviz?.isVisible()) {
				this.treeviz?.renderView(this.getTreeStructure(), this.formula, { cursor: this.ghostNode?.nodeId, ...opt });
			}
		}
		const delayedRefresh = () => {
			clearTimeout(this.timer);
			this.timer = setTimeout(() => {
				refresh();
			}, this.maxTimer);
		}
		if (this.enabled){
			this.tcounter++;
			if (opt.force || this.tcounter > this.maxSkip) {
				this.tcounter = 0;
				clearTimeout(this.timer);
				refresh();
			} else {
				delayedRefresh();
			}
		}
	}
	/**
	 * Utility function, checks if the tree view is visible
	 */
	isVisible (): boolean  {
		return this.view?.visible;
	}
	/**
	 * Utility function, disables the tree view (i.e., hides the view)
	 */
	disableView (): void {
		this.enabled = false;
		clearTimeout(this.timer);
		vscode.commands.executeCommand('setContext', 'proof-explorer.visible', false);
	}
	/**
	 * Utility function, enables the tree view (i.e., reveals the view)
	 */
	enableView (): void {
		this.enabled = true;
		vscode.commands.executeCommand('setContext', 'proof-explorer.visible', true);
		this.focusActiveNode();
	}

	/**
	 * Internal function, used to delete the tree view
	 */
	disposeView(): void {
		this.root = null;
		// don't reset the clipboard flags, so the user can paste proof commands from the previous proof attempt
		// vscode.commands.executeCommand('setContext', 'proof-explorer.clipboard-contains-node', false);
		// vscode.commands.executeCommand('setContext', 'proof-explorer.clipboard-contains-tree', false);
		this.resetView();
		this.disableView();
	}

	/**
	 * Utility function, sets the initial sequent.
	 */
	didLoadSequent (sequent: SequentDescriptor): void {
		// this.proofState = sequent;
		if (this.activeNode) {
			this.activeNode.updateSequent(sequent);
		} else {
			this.root.updateSequent(sequent);
		}
	}

	/**
	 * Handler for sequent updates
	 */
	didUpdateSequent (desc: ProofExecDidUpdateSequent): void {
		if (desc && desc.selected) {
			if (desc.selected.name === "ghost") {
				this.ghostNode.updateSequent(desc.sequent);
				this.refreshView({ source: "did-update-tooltip" });
			} else {
				const selected: ProofItem = this.findNode(desc.selected.id);
				if (selected) {
					selected.updateSequent(desc.sequent);
					this.refreshView({ source: "did-update-tooltip" });
				}
			}
		}
	}

	/**
	 * Handler for start proof events
	 */
	didStartProof (): void {
		this.running = false;
		vscode.commands.executeCommand('setContext', 'proof-explorer.running', false);
		this.searchCache = {};
		this.refreshView({ force: true, source: "did-start-proof" });
		if (this.root && this.root.children && this.root.children.length) {
			if (isGlassboxTactic(this.root.children[0].name)) {
				this.queryUnfoldGlassbox();
			}
		}
	}

	/**
	 * Utility function that can be used by other classes to obtain the tree structure of the proof tree
	 * Attributes span, depths and height of the tree structure are not computed in the current implementation.
	 * @param item Current node being processed.
	 */
	getTreeStructure (): TreeStructure {
		return this.createTreeStructure();
	}

	/**
	 * Generates a tree structure that takes into account cursor and parent-child relation of nodes
	 * Attributes span, depths and height of the tree structure are not computed in the current implementation.
	 * @param item Current node being processed.
	 */
	protected createTreeStructure (item?: ProofItem): TreeStructure {
		if (item === undefined) { item = this.root; }
		if (item) {
			const ans: TreeStructure = {
				id: item?.nodeId,
				name: item?.name,
				type: item?.getType(),
				status: {
					complete: item?.isComplete(),
					visited: item?.isVisited(),
					active: item?.isActive(),
					pending: item?.isPending()
				}
			};
			const children: ProofItem[] = item.children;
			let p: TreeStructure = ans;
			let q: TreeStructure = ans;
			if (children?.length) {
				for (let i = 0; i < children.length; i++) {
					// ProofItems are encoded in a compact way: the first child is a child, the others are descendents
					// i.e., the parent of child(i) is child(i-1)
					if (i > 0 && children[i].contextValue !== "proof-branch") {
						q = p.children[p.children.length - 1];
						p = q;
					}
					q.children = q.children || [];
					q.children.push(this.createTreeStructure(children[i]));
				}
			}
			// handle ghost node
			if (this.ghostNode && this.ghostNode.isActive() && this.ghostNode.realNode?.nodeId === item.nodeId) {
				q.children = q.children || [];
				q.children.push({
					id: this.ghostNode.nodeId,
					name: "...",
					status: {
						complete: false,
						visited: false,
						active: true,
						pending: false
					}
				});
				// ans.status.active = true;
			}
			return ans;
		}
		return null;
    }
	
	/**
	 * Internal function, converts a nodex structure sent by the servwr to a proof item for the tree view
	 */
	protected convertNodeX2ProofItem (elem: ProofNodeX, parent?: ProofItem): ProofItem[] {
		const fromNodeX2 = (elem: ProofNodeX, parent?: ProofItem): ProofItem => {
			const node: ProofItem = (elem.type === "proof-command") ? 
					new ProofCommand({ id: elem.id, cmd: elem.name, branchId: elem.branch, parent }) 
					: new ProofBranch({ id: elem.id, cmd: elem.name, branchId: elem.branch, parent });
			if (parent) {
				parent.appendChild(node);
			}
			if (elem.rules && elem.rules.length) {
				elem.rules.forEach(child => {
					fromNodeX2(child, node);
				});
			} else {
				node.collapsibleState = TreeItemCollapsibleState.None;
			}
			if (node?.nodeId) {
				this.searchCache[node.nodeId] = node;
			}
			return node;
		}
		const items: ProofItem[] = []
		if (elem.type === "root") {
			// convert only its children
			for (let i = 0; i < elem.rules.length; i++) {
				const item: ProofItem = fromNodeX2(elem.rules[i], parent);
				items.push(item);
			}
		} else {
			// append elem
			const item: ProofItem = fromNodeX2(elem, parent);
			items.push(item);				
		}
		return items;
	}
	/**
	 * Loads a proof structure
	 */
	loadProofStructure (formula: PvsFormula, desc: ProofDescriptor, proof: ProofNodeX): void {
		this.formula = formula;
		this.root = new RootNode({
			id: proof.id,
			name: proof.name, 
			proofStatus: (desc && desc.info && desc.info.status) ? desc.info.status : "unfinished"
		});
		this.ghostNode = new GhostNode({ parent: this.root, node: this.root });

		if (proof.rules && proof.rules.length) {
			this.root.children = this.convertNodeX2ProofItem(proof, this.root);
		}
		this.refreshView({ source: "did-load-proof" });
	}
	/**
	 * Loads a proof descriptor in proof-explorer
	 */
	loadProofDescriptor (desc: ProofDescriptor): void {
		// utility function for building the proof tree
		const createTree = (elem: ProofNode, parent: ProofItem): void => {
			const node: ProofItem = (elem.type === "proof-command") ? 
				new ProofCommand({ cmd: elem.name, branchId: elem.branch, parent }) 
				: new ProofBranch({ cmd: elem.name, branchId: elem.branch, parent });
			parent.appendChild(node);
			if (elem.rules && elem.rules.length) {
				elem.rules.forEach(child => {
					createTree(child, node);
				});
			} else {
				node.collapsibleState = TreeItemCollapsibleState.None;
			}
		}
		// initialise
		this.root = null;
		this.refreshView({ source: "did-load-descriptor" });
		if (desc && desc.info) {
			this.root = new RootNode({ 
				name: desc.info.formula, //(desc.proof) ? desc.proof.name : desc.info.formula, 
				proofStatus: desc.info.status
			});
			this.ghostNode = new GhostNode({ parent: this.root, node: this.root });
			if (desc.proofTree && desc.proofTree.rules && desc.proofTree.rules.length
					// when proof is simply (postpone), this is an empty proof, don't append postpone
					&& !(desc.proofTree.rules.length === 1 && isPostponeCommand(desc.proofTree.rules[0].name))) {
				desc.proofTree.rules.forEach((child: ProofNode) => {
					createTree(child, this.root);
				});
			} else {
				this.root.collapsibleState = TreeItemCollapsibleState.None;
			}
			this.proofDescriptor = desc;
		} else {
			console.warn(`[proof-explorer] Warning: null descriptor`);
		}
		// refresh view
		this.refreshView({ source: "did-load-descriptor" });
	}

	/**
	 * Shows a yes/no query to the user, to confirm the run-proof action
	 * @param msg 
	 */
	async queryRunProof (msg: string): Promise<boolean> {
		const yesno: string[] = [ "Run Proof", "No" ];
		const ans: string = await vscode.window.showInformationMessage(msg, { modal: true }, yesno[0]);
		return ans === yesno[0];
	}
	/**
	 * Query unfold glassbox
	 */
	async queryUnfoldGlassbox (): Promise<void> {
		const msg: string = `The proof script has been imported from ProofLite. To view the proof structure in proof-explorer, you need to run the proof.`;
		const actionConfirmed: boolean = await this.queryRunProof(msg);
		if (actionConfirmed) {
			commands.executeCommand("proof-explorer.run-proof", { force: true });
		}
	}
	/**
	 * Save the current proof on file
	 * @param opt Optionals: whether confirmation is necessary before saving (default: confirmation is not needed)  
	 */
	// async queryQuitProofAndSave (opt?: { msg?: string }): Promise<boolean> {
	// 	opt = opt || {};
	// 	const note: string = (opt.msg) ? `${opt.msg}\n` : "";
	// 	const msg: string = (this.root) ? note + `Save proof ${this.root.name}?` : note + "Save proof?";
	// 	const actionConfirmed: boolean = await this.queryConfirmation(msg);
	// 	if (actionConfirmed) {
	// 		// send quit-and-save to the server
	// 		const action: ProofExecQuitAndSave = { action: "quit-proof-and-save" };
	// 		this.client.sendRequest(serverEvent.querySaveProofResponse, action);
	// 	} else {
	// 		// send quit to the server
	// 		const action: ProofExecQuit = { action: "quit-proof" };
	// 		this.client.sendRequest(serverEvent.querySaveProofResponse, action);
	// 	}
	// 	return actionConfirmed;
	// }
	async queryQuitProof (opt?: { force?: boolean }): Promise<boolean> {
		// ask confirmation before quitting proof
		const actionConfirmed: boolean = opt?.force ? true : await this.queryConfirmation("Quit Proof Session?");
		if (actionConfirmed) {
			const action: ProofExecQuit = { action: "quit-proof" };
			this.client.sendRequest(serverRequest.proverCommand, action);
			this.running = false;
		}
		return actionConfirmed;
	}
	/**
	 * Save the current proof on file
	 * @param opt Optionals: whether confirmation is necessary before saving (default: confirmation is not needed)  
	 */
	async queryQuitProofAndSave (opt?: { msg?: string }): Promise<YesNoCancel> {
		opt = opt || {};
		const note: string = (opt.msg) ? `${opt.msg}\n` : "";
		const msg: string = (this.root) ? note + `Save proof '${this.root.name}' before quitting?` : note + "Save proof before quitting?";
		const ans: YesNoCancel = await this.queryYesNoCancel(msg);
		switch (ans) {
			case "yes": {
				// quit-proof-and-save	
				const action: ProofExecQuitAndSave = { action: "quit-proof-and-save" };
				this.client.sendRequest(serverRequest.proverCommand, action);
				this.running = false;
				break;
			}
			case "no": {
				// send quit to the server
				const action: ProofExecQuit = { action: "quit-proof" };
				this.client.sendRequest(serverRequest.proverCommand, action);
				this.running = false;
				break;
			}
			case "cancel":
			default: {
				// do nothing
				break;
			}
		}
		return ans;
	}
	/**
	 * Quit the current proof
	 */
	// async quitProof (): Promise<void> {
	// 	const actionConfirmed: boolean = await this.queryConfirmation("Quit Proof Session?");
	// 	if (actionConfirmed) {
	// 		// send quit to the server
	// 		this.client.sendRequest(serverRequest.proofCommand, {
	// 			fileName: this.formula.fileName,
	// 			fileExtension: this.formula.fileExtension,
	// 			theoryName: this.formula.theoryName,
	// 			formulaName: this.formula.formulaName,
	// 			contextFolder: this.formula.contextFolder,
	// 			cmd: "save-then-quit"
	// 		});
	// 		// commands.executeCommand("vscode-pvs.send-proof-command", {
	// 		// 	fileName: this.formula.fileName,
	// 		// 	fileExtension: this.formula.fileExtension,
	// 		// 	theoryName: this.formula.theoryName,
	// 		// 	formulaName: this.formula.formulaName,
	// 		// 	contextFolder: this.formula.contextFolder,
	// 		// 	cmd: "save-then-quit"
	// 		// });
	// 	}
	// }
	/**
	 * Shows a yes-no-cancel dialog
	 */
	async queryYesNoCancel (msg: string): Promise<YesNoCancel> {
		const yesnocancel: string[] = [ "Yes", "No" ];
		const ans: string = await vscode.window.showInformationMessage(msg, { modal: true }, yesnocancel[0], yesnocancel[1]);
		switch (ans) {
			case "Yes": { return "yes"; }
			case "No": { return "no"; }
			default: {
				return "cancel";
			}
		}
	}
	async queryConfirmation (msg: string): Promise<boolean> {
		const yesno: string[] = [ "Yes", "No" ];
		const ans: string = await vscode.window.showInformationMessage(msg, { modal: true }, yesno[0]);
		return ans === yesno[0];
	}
	async proveFormulaAtCursorPosition (): Promise<PvsFormula> {
		if (window.activeTextEditor && window.activeTextEditor.document) {
			// if the file is currently open in the editor, save file first
			await window.activeTextEditor.document.save();
			// get information necessary to start the proof
			const fname: string = window.activeTextEditor.document.fileName;
			const cursorPosition: vscode.Position = window.activeTextEditor.selection?.active;
			// const range: vscode.Range = new vscode.Range(new vscode.Position(0, 0), cursorPosition);
			const text: string = window.activeTextEditor.document.getText();
			const desc: PvsFormula = {
				theoryName: findTheoryName(text, cursorPosition.line),
				formulaName: findFormulaName(text, cursorPosition.line),
				fileName: fsUtils.getFileName(fname),
				fileExtension: fsUtils.getFileExtension(fname),
				contextFolder: fsUtils.getContextFolder(fname)
			};
			if (desc && desc.theoryName && desc.formulaName && desc.fileName && desc.fileExtension && desc.contextFolder) {
								// ask the user confirmation before restarting pvs
				const yesno: string[] = [ "Yes", "No" ];
				const msg: string = `Prove formula ${desc.formulaName}?`;
				const ans: string = await vscode.window.showInformationMessage(msg, { modal: true }, yesno[0]);
				if (ans === yesno[0] || ans === yesno[1]) {
					commands.executeCommand("vscode-pvs.prove-formula", desc);
				}
			}
			return desc;
		}
		return null;
	}
	async queryPauseProof (): Promise<boolean> {
		// ask the user confirmation before pausing
		const yesno: string[] = [ "Yes", "No" ];
		const msg: string = `Pause the execution of the current proof?`;
		const ans: string = await vscode.window.showInformationMessage(msg, { modal: true }, yesno[0])
		if (ans === yesno[0]) {
			this.pauseProof();
			return true;
		}
		return false;
	}
	/**
	 * Sends interrupt-prover to the server
	 */
	pauseProof (): void {
		this.running = false;
		vscode.commands.executeCommand('setContext', 'proof-explorer.running', false);
		const action: ProofExecInterruptProver = { action: "interrupt-prover" };
		this.client.sendRequest(serverRequest.proverCommand, action);
	}
	protected onDidUpdateNodeStatus (desc: { id: string, name: string, status: ProofNodeStatus }): void{
		if (this.root && desc) {
			const node: ProofItem = this.findNode(desc.id);
			if (node) {
				if (desc.status === "active") {
					this.activeNode = node;
					if (this.fft?.id === this.activeNode.nodeId) {
						this.running = false;
						this.fft = null;
						this.trigger(ProofExplorerEvent.didStopExecution);
					}
				}
				node.updateStatus(desc.status);
				// if (desc.status !== "complete") {
				// 	this.expandNode(desc);
				// }
				this.refreshView({ source: "did-update-node-status" });
			} else {
				console.warn(`[vscode-proof-explorer] Warning: could not update status of node ${desc.name} to ${desc.status}`);
			}
		}
	}
	/**
	 * Activation function, installs all proof-explorer command handlers.
	 * @param context Client context 
	 */
	activate (context: ExtensionContext): void {
		this.treeviz?.activate(context);
		// -- handler for node updates
		this.client.onNotification(serverEvent.proofNodeUpdate, (desc: { id: string, name: string, status: ProofNodeStatus }) => {
			this.onDidUpdateNodeStatus(desc);
		});
		context.subscriptions.push(commands.registerCommand("proof-explorer.reveal-node", (desc: { id: string, name: string }) => {
            this.revealNode(desc);
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.fold-proved-branches", (desc: { id: string, name: string }) => {
            this.foldProvedBranches();
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.focus-node", (desc: { id: string, name: string }) => {
            this.revealNode(desc);
		}));
		// -- handlers for proof explorer commands
		context.subscriptions.push(commands.registerCommand("proof-explorer.trim-unused", (resource: ProofItem) => {
			// save proof without asking confirmation
			const action: ProofEditTrimUnused = { action: "trim-unused" };
			this.client.sendRequest(serverRequest.proverCommand, action);
		}));
		// context.subscriptions.push(commands.registerCommand("proof-explorer.save-proof", () => {
		// 	// save proof without asking confirmation
		// 	const action: ProofExecQuitAndSave = { action: "quit-proof-and-save" };
		// 	this.client.sendRequest(serverRequest.proverCommand, action);
		// }));
		// context.subscriptions.push(commands.registerCommand("proof-explorer.save-proof-as-prf", () => {
		// 	// save proof without asking confirmation
		// 	const action: ProofEditSaveAs = { action: "export-proof", fileExtension: ".prf" };
		// 	this.client.sendRequest(serverRequest.proverCommand, action);
		// }));
		context.subscriptions.push(commands.registerCommand("proof-explorer.export-prooflite", () => {
			// save proof without asking confirmation
			const action: ProofEditExportProof = { action: "export-proof", proofFile: { fileExtension: ".prl" }};
			this.client.sendRequest(serverRequest.proverCommand, action);
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.import-proof", async () => {
			if (this.formula && this.formula.theoryName && this.formula.formulaName) {
				const desc: FileDescriptor = {
					contextFolder: this.formula.contextFolder,
					fileName: this.formula.fileName,
					fileExtension: ".prf"
				};	
				if (desc && desc.contextFolder && desc.fileName && desc.fileExtension) {
					// const formulaName: string = await vscode.window.showQuickPick(["a", "b", "c"]);
					// if (formulaName) {
					// 	const action: ProofExecImportProof = {
					// 		action: "import-proof",
					// 		proofFile: desc,
					// 		formula: this.formula
					// 	};
					// 	this.client.sendRequest(serverRequest.proverCommand, action);
					// }
					let formulaName: string = await vscode.window.showInputBox({
						prompt: `Please enter name of the proof to be imported`, 
						value: "", 
						ignoreFocusOut: true
					});
					if (formulaName) {
						const formula: PvsFormula = {
							contextFolder: desc.contextFolder,
							fileName: desc.fileName,
							fileExtension: ".pvs",
							theoryName: this.formula.theoryName,
							formulaName
						};
						const action: ProofExecImportProof = {
							action: "import-proof",
							proofFile: desc,
							formula
						};
						this.client.sendRequest(serverRequest.proverCommand, action);
					}
				}
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.new-proof", async () => {
			 // ask confirmation before deleting a node
			 if (this.formula) {
				const msg: string = `Start a new proof for ${this.formula.formulaName}?`;
				const actionConfirmed: boolean = await this.queryConfirmation(msg);
				if (actionConfirmed) {
					const action: ProofExecStartNewProof = { action: "start-new-proof", formula: this.formula };
					console.log(`[vscode-proof-explorer] Starting new proof for ${this.formula.formulaName}`);
					this.client.sendRequest(serverRequest.proverCommand, action);
				}
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.open-proof", async () => {
			if (this.formula && this.formula.theoryName && this.formula.formulaName) {
				const desc: FileDescriptor = await vscodeUtils.openProofFile();
				if (desc && desc.fileExtension) {
					const action: ProofExecOpenProof = {
						action: "open-proof",
						proofFile: desc,
						formula: this.formula
					};
					this.client.sendRequest(serverRequest.proverCommand, action);
				}
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.import-prooflite", async () => {
			if (this.formula && this.formula.theoryName && this.formula.formulaName) {
				const desc: FileDescriptor = await vscodeUtils.openProofFile({ defaultExtension: ".prl" });
				if (desc && desc.fileExtension) {
					const action: ProofExecOpenProof = {
						action: "open-proof",
						proofFile: desc,
						formula: this.formula,
						opt: {
							restartProof: true
						}
					};
					this.client.sendRequest(serverRequest.proverCommand, action);
				}
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.import-jprf", async () => {
			if (this.formula && this.formula.theoryName && this.formula.formulaName) {
				const desc: FileDescriptor = await vscodeUtils.openProofFile({ defaultExtension: ".jprf" });
				if (desc && desc.fileExtension) {
					const action: ProofExecOpenProof = {
						action: "open-proof",
						proofFile: desc,
						formula: this.formula,
						opt: {
							restartProof: true
						}
					};
					this.client.sendRequest(serverRequest.proverCommand, action);
				}
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.restore-from-jprf", async () => {	
			if (this.formula && this.formula.theoryName && this.formula.formulaName) {
				const yesno: string[] = [ "Yes", "No" ];
				const msg: string = `Restore last saved proof for formula '${this.formula.formulaName}'?\n\n(The prover session will be restarted)\n`;
				const ans: string = await vscode.window.showInformationMessage(msg, { modal: true }, yesno[0]);
				if (ans === yesno[0]) {
					const proofFile: FileDescriptor = {
						contextFolder: this.formula.contextFolder,
						fileName: this.formula.fileName,
						fileExtension: ".jprf"
					};
					const action: ProofExecOpenProof = {
						action: "open-proof",
						proofFile,
						formula: this.formula,
						opt: {
							restartProof: true
						}
					};
					this.client.sendRequest(serverRequest.proverCommand, action);
				}
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.quit-proof", async () => {
			if (this.dirtyFlag) {
				await this.queryQuitProofAndSave();
			} else {
				await this.queryQuitProof();
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.forward", () => {
			this.running = false;
			// execute next proof command
			if (!this.ghostNode?.isActive()) {
				const cmd: string = this.activeNode?.name;
				vscode.commands.executeCommand("xterm-pvs.send-command", { cmd });
				// const action: ProofExecForward = { action: "forward" };
				// this.client.sendRequest(serverRequest.proverCommand, action);
				vscode.commands.executeCommand("xterm.showFeedbackWhileExecuting", { cmd: this.activeNode.name });
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.back", () => {
			this.running = false;
			// go back one proof command
			const action: ProofExecBack = { action: "back" };
			this.client.sendRequest(serverRequest.proverCommand, action);
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.fast-forward", (resource?: ProofItem) => {
			// fast forward proof to a given proof command
			if (resource?.name && resource?.id) {
				this.fastForwardTo({ id: resource.nodeId, name: resource.name });
				vscode.commands.executeCommand("xterm.showFeedbackWhileExecuting", { cmd: "fast-forward", target: resource.name });
			}
			// const action: ProofExecFastForward = { action: "fast-forward", selected: { id: resource.id, name: resource.name } };
			// console.log(`[vscode-proof-explorer] Fast forward to ${resource.name} (${resource.id})`);
			// this.client.sendRequest(serverRequest.proverCommand, action);
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.rewind", (resource?: ProofItem) => {
			// rewind to a given proof command
			if (resource?.name && resource?.id) {
				this.rewindTo({ id: resource.nodeId, name: resource.name });
				vscode.commands.executeCommand("xterm.showFeedbackWhileExecuting", { cmd: "rewind", target: resource.name });
			}
			// const action: ProofExecRewind = { action: "rewind", selected: { id: resource.id, name: resource.name } };
			// console.log(`[vscode-proof-explorer] Rewinding to ${resource.name} (${resource.id})`);
			// this.client.sendRequest(serverRequest.proverCommand, action);
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.run-proof", async (opt?: { force?: boolean }) => {
			opt = opt || {};
			const confirm: boolean = opt.force || await this.queryConfirmation(`Run proof ${this.getProofName()}?`);
			if (confirm) {
				this.run();
			}
			// if (this.serverMode === "in-checker") {
			// 	// run entire proof
			// 	const action: ProofExecRun = { action: "run" };
			// 	this.client.sendRequest(serverRequest.proverCommand, action);
			// } else {
			// 	commands.executeCommand("vscode-pvs.prove-formula", this.formula);
			// }
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.pause-proof", async () => {
            this.queryPauseProof();
        }));
		context.subscriptions.push(commands.registerCommand("proof-explorer.copy-node", (resource?: ProofItem) => {
			// copy selected node
			if (resource) {
				const action: ProofEditCopyNode = { action: "copy-node", selected: { id: resource.nodeId, name: resource.name } };
				console.log(`[vscode-proof-explorer] Copy node ${resource.name} (${resource.nodeId})`);
				this.client.sendRequest(serverRequest.proverCommand, action);
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.copy-subtree", (resource?: ProofItem) => {
			// copy selected node
			if (resource) {
				const action: ProofEditCopyTree = { action: "copy-tree", selected: { id: resource.nodeId, name: resource.name } };
				console.log(`[vscode-proof-explorer] Copy tree rooted at ${resource.name} (${resource.nodeId})`);
				this.client.sendRequest(serverRequest.proverCommand, action);
			}
		}));
		// context.subscriptions.push(commands.registerCommand("proof-explorer.paste-before-proof-command", (resource: ProofItem) => {
		// 	this.pasteBeforeNode({ selected: resource });
		// }));
		context.subscriptions.push(commands.registerCommand("proof-explorer.paste-node", (resource?: ProofItem) => {
			if (resource) {
				const action: ProofEditPasteNode = { action: "paste-node", selected: { id: resource.nodeId, name: resource.name } };
				console.log(`[vscode-proof-explorer] Pasting clipboard content at ${resource.name} (${resource.nodeId})`);
				this.client.sendRequest(serverRequest.proverCommand, action);
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.paste-subtree", (resource?: ProofItem) => {
			if (resource) {
				const action: ProofEditPasteTree = { action: "paste-tree", selected: { id: resource.nodeId, name: resource.name } };
				console.log(`[vscode-proof-explorer] Pasting clipboard content at ${resource.name} (${resource.nodeId})`);
				this.client.sendRequest(serverRequest.proverCommand, action);
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.delete-node", async (resource?: ProofItem) => {
			// ask confirmation before deleting a node
			if (resource) {
				const msg: string = (resource.contextValue === "root") ? `Delete current proof?` : `Delete ${resource.name}?`;
				const actionConfirmed: boolean = await this.queryConfirmation(msg);
				if (actionConfirmed) {
					const action: ProofEditDeleteNode = { action: "delete-node", selected: { id: resource.nodeId, name: resource.name } };
					console.log(`[vscode-proof-explorer] Deleting node ${resource.name} (${resource.nodeId})`);
					this.client.sendRequest(serverRequest.proverCommand, action);
				}
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.trim-node", async (resource?: ProofItem) => {
			if (resource) {
				const msg: string = resource.contextValue === "root" ? `Delete current proof?` 
					: resource.contextValue === "proof-branch" ? `Delete proof commands in branch ${resource.name}?`
						: `Delete proof commands after ${resource.name}?`;
				const actionConfirmed: boolean = await this.queryConfirmation(msg);
				if (actionConfirmed) {
					const action: ProofEditTrimNode = { action: "trim-node", selected: { id: resource.nodeId, name: resource.name } };
					console.log(`[vscode-proof-explorer] Trimming node ${resource.name} (${resource.nodeId})`);
					this.client.sendRequest(serverRequest.proverCommand, action);
				}
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.slice-tree", async (resource?: ProofItem) => {
			if (resource) {
				if (!resource.isVisited() && !resource.isActive() && this.activeNode) {
					const msg: string = `Jump to ${resource.name}?\n\nPlease note that this action will also cut all nodes from ${this.activeNode.name} to ${resource.name}.`;
					const actionConfirmed: boolean = await this.queryConfirmation(msg);
					if (actionConfirmed) {
						const action: ProofEditSliceTree = { action: "slice-tree", selected: { id: resource.nodeId, name: resource.name } };
						console.log(`[vscode-proof-explorer] Slicing nodes between ${this.activeNode.name} and ${resource.name} (${resource.nodeId})`);
						this.client.sendRequest(serverRequest.proverCommand, action);
					}
				} else {
					vscodeUtils.showInformationMessage(`Slice can only be performed on proof commands that have not been executed already.`);
				}
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.delete-tree", async (resource?: ProofItem) => {
			if (resource) {
				const msg: string = (resource.contextValue === "root") ? `Delete current proof?` 
						: `Delete ${resource.name}?`;
				const actionConfirmed: boolean = await this.queryConfirmation(msg);
				if (actionConfirmed) {
					const action: ProofEditDeleteTree = { action: "delete-tree", selected: { id: resource.nodeId, name: resource.name } };
					console.log(`[vscode-proof-explorer] Deleting tree rooted at ${resource.name} (${resource.nodeId})`);
					this.client.sendRequest(serverRequest.proverCommand, action);
				}
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.cut-node", (resource?: ProofItem) => {
			if (resource) {
				const action: ProofEditCutNode = { action: "cut-node", selected: { id: resource.nodeId, name: resource.name } };
				console.log(`[vscode-proof-explorer] Cutting node ${resource.name} (${resource.nodeId})`);
				this.client.sendRequest(serverRequest.proverCommand, action);
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.cut-subtree", async (resource?: ProofItem) => {
			if (resource) {
				const msg: string = `Cut subtree rooted at ${resource.name}?`;
				const actionConfirmed: boolean = await this.queryConfirmation(msg);
				if (actionConfirmed) {
					const action: ProofEditCutTree = { action: "cut-tree", selected: { id: resource.nodeId, name: resource.name } };
					console.log(`[vscode-proof-explorer] Cutting tree rooted at ${resource.name} (${resource.nodeId})`);
					this.client.sendRequest(serverRequest.proverCommand, action);
				}
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.slice-subtree", (resource?: ProofItem) => {
			if (resource) {
				const action: ProofEditSliceTree = { action: "slice-tree", selected: { id: resource.nodeId, name: resource.name } };
				console.log(`[vscode-proof-explorer] Slicing tree rooted at ${resource.name} (${resource.nodeId})`);
				this.client.sendRequest(serverRequest.proverCommand, action);
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.new-proof-command", async (resource?: ProofItem) => {
			if (resource) {
				const name: string = await vscode.window.showInputBox({
					prompt: `Please enter proof command to be appended after ${resource.name}`,
					placeHolder: ``,
					value: ``,
					ignoreFocusOut: true 
				});
				if (name) {
					const action: ProofEditAppendNode = { action: "append-node", selected: { id: resource.nodeId, name: resource.name }, name };
					// console.log(`[vscode-proof-explorer] Appending ${name} at ${resource.name} (${resource.id})`);
					this.client.sendRequest(serverRequest.proverCommand, action);
				}
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.create-proof-branch", (resource?: ProofItem) => {
			if (resource) {
				const action: ProofEditAppendBranch = { action: "append-branch", selected: { id: resource.nodeId, name: resource.name } };
				// console.log(`[vscode-proof-explorer] Appending new branch at ${resource.name} (${resource.id})`);
				this.client.sendRequest(serverRequest.proverCommand, action);
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.edit-node", async (resource?: ProofItem) => {
			if (resource?.name === undefined) { resource = this.activeNode; }
			if (resource) {
				let newName: string = await vscode.window.showInputBox({ prompt: `Editing proof command ${resource.name}`, placeHolder: `${resource.name}`, value: `${resource.name}`, ignoreFocusOut: true });
				if (newName) {
					const action: ProofEditRenameNode = { action: "rename-node", selected: { id: resource.nodeId, name: resource.name }, newName };
					console.log(`[vscode-proof-explorer] Renaming node ${resource.name} (${resource.nodeId})`);
					this.client.sendRequest(serverRequest.proverCommand, action);
				}
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.show-sequent", (resource?: ProofItem) => {
			if (this.formula?.contextFolder && resource?.getSequent()) {
				const name: string = `${this.formula.theoryName}${fsUtils.logFileExtension}`;
				const info: string = formatSequent(resource.getSequent(), { formulasOnly: true }).trim();
				vscodeUtils.previewTextDocument(name, info, { contextFolder: path.join(this.formula.contextFolder, "pvsbin")});
			} else {
				vscodeUtils.showInformationMessage(`Sequent information not yet available for this proof node`);
			}
		}));
		context.subscriptions.push(commands.registerCommand("proof-explorer.show-active-sequent", (resource?: ProofItem) => {
			if (this.formula?.contextFolder && resource?.getSequent()) {
				const name: string = `${this.formula.theoryName}${fsUtils.logFileExtension}`;
				const info: string = formatSequent(resource.getSequent(), { formulasOnly: true }).trim();
				vscodeUtils.previewTextDocument(name, info, { contextFolder: path.join(this.formula.contextFolder, "pvsbin")});
			} else {
				vscodeUtils.showInformationMessage(`Sequent information not yet available for this proof node`);
			}
		}));

		let cmd: string = null;
		// click on the any node (except ghost nodes) enables search by type in the tree view
		context.subscriptions.push(commands.registerCommand('proof-explorer.root-selected', async (resource: ProofItem) => {
			if (this.filterOnTypeActive) { // this will capture future attempt to toggle the filter -- there's no other way to keep this filter on
				this.filterOnTypeActive = false;
				commands.executeCommand('list.toggleFilterOnType', false);
			}
		}));
		context.subscriptions.push(commands.registerCommand('proof-explorer.did-select-proof-branch', async (resource: ProofItem) => {
			if (this.filterOnTypeActive) { // this will capture future attempt to toggle the filter -- there's no other way to keep this filter on
				this.filterOnTypeActive = false;
				commands.executeCommand('list.toggleFilterOnType', false);
			}
		}));
		context.subscriptions.push(commands.registerCommand('proof-explorer.did-select-proof-command', async (resource: ProofItem) => {
			if (this.filterOnTypeActive) { // this will capture future attempt to toggle the filter -- there's no other way to keep this filter on
				this.filterOnTypeActive = false;
				commands.executeCommand('list.toggleFilterOnType', false);
			}
			// register double click handler
			if (!cmd || cmd !== resource.name) {
				cmd = resource.name;
				setTimeout(() => {
					cmd = null;
				}, 500);
			} else {
				const dd: PvsProofCommand = { 
					fileName: this.formula.fileName,
					fileExtension: this.formula.fileExtension,
					contextFolder: this.formula.contextFolder,
					theoryName: this.formula.theoryName, 
					formulaName: this.formula.formulaName,
					cmd
				}
				commands.executeCommand("proof-explorer.proof-command-dblclicked", dd);
				cmd = null;
			}
		}));
		
	}

	/**
	 * Returns the children of a node in the proof tree
	 * @param item A node in the proof tree 
	 */
	getAllChildren (item?: TreeItem): ProofItem[] {
		if (item) {
			let children: ProofItem[] = (<ProofItem> item).getChildren();
			if (this.ghostNode && this.ghostNode.isActive()) {
				for (let i = 0; i < children.length; i++) {
					if (children[i] === this.ghostNode.realNode) {
						const res: ProofItem[] = children.slice(0, i + 1).concat([this.ghostNode]).concat(children.slice(i + 1));
						return res;
					}
				}
			}
			return children;	
		} else if (this.root) {
			return (this.root.children?.length) ? [ this.root ]
			: [ this.root, this.ghostNode ];
		}
		return null;
	}

	/**
	 * Function inherited from tree data provider
	 * @param item A node in the proof tree 
	 */
	getChildren(item: TreeItem): Thenable<TreeItem[]> {
		// node
		if (item) {
			const children: TreeItem[] = this.getAllChildren(item);
			return Promise.resolve(children);
		} else if (this.root) {
			this.loading.stop();
			const children: TreeItem[] = this.getAllChildren();
			return Promise.resolve(children);
		} else {
			this.loading.start().then(() => { this.refreshView({ source: "load" }); });
			return Promise.resolve([ this.loading ]);
		}
	}
	/**
	 * Returns the requested node
	 * @param item Node to be returned
	 */
	getTreeItem(item: TreeItem): TreeItem {
		return (this.enabled) ? item : null;
	}
	/**
	 * Returns the parent of a node. This method is necessaty for the correct execution of view.reveal()
	 * @param item Node whose parent should be returned
	 */
	getParent(item: ProofItem): ProofItem {
		if (item.contextValue === "root") {
			return null;
		}
		// ghost node needs special treatment
		// we need to return the parent of the ghost rather than that of ghost.realNode otherwhise vscode won't be able to show up the ghost
		// ghost.realNode.parent should not be returned otherwise vscode will generate an exception because the same node (the parent) is counted twice
		// if (item === this.ghostNode && !this.ghostNode.isActive()) {
		// 	return null;
		// }
		return item.parent;
	}
}


//-------------------------------------------------------------
// Auxiliary constants and definitions
//-------------------------------------------------------------

// https://emojipedia.org/symbols/
//  ❌ 🔵 ⚫ ⚪ 🔴 🔽 🔼 ⏯ ⏩ ⏪ ⏫ ⏬ ▶️ ◀️ ⭕ 🔹🔸💠🔷🔶
// use https://iconify.design/icon-sets/ for proof explorer, to have a consistent look&feel on all systems.

export const QED: ProofStatus = "proved";

/**
 * Base class for proof tree items
 */
export abstract class ProofItem extends TreeItem {
	contextValue: string = "proofItem";
	name: string; // prover command or branch id
	nodeId: string;
	branchId: string = ""; // branch in the proof tree where this command is located (branchId for root is "").
	command: Command; // vscode action associated to the node

	children: ProofItem[] = [];
	parent: ProofItem;
	protected activeFlag: boolean = false;
	protected visitedFlag: boolean = false;
	protected pendingFlag: boolean = false;
	protected completeFlag: boolean = false;

	// sequent *before* the execution of the node
	protected sequent: SequentDescriptor = null;

	/**
	 * Constructor
	 */
	constructor (desc: { id?: string, type: string, name: string, branchId: string, parent: ProofItem, collapsibleState?: TreeItemCollapsibleState }) {
		super(desc.type, (desc.collapsibleState === undefined) ? TreeItemCollapsibleState.Expanded : desc.collapsibleState);
		this.contextValue = desc.type;
		this.id = fsUtils.get_fresh_id();
		this.nodeId = (desc.id) ? desc.id : fsUtils.get_fresh_id();
		this.name = desc.name;
		this.branchId = desc.branchId;
		this.parent = desc.parent;
		this.tooltip = "";//"Double click copies command to prover console";
		this.notVisited();
	}
	/**
	 * Utility function, returns the node type, one of: root, proof-branch, proof-node, ghost
	 */
	getType(): NodeType {
		switch (this.contextValue) {
			case "root": { return "root"; }
			case "proof-branch": { return "proof-branch"; }
			case "proof-node": { return "proof-node"; }
			case "ghost": { return "ghost"; }
			default: {
				return null;
			}
		}
	}
	/**
	 * Utility function, updates sequent information for the tree item
	 */
	updateSequent (sequent?: SequentDescriptor): void {
		this.sequent = sequent;
		this.tooltip = sequent ? formatSequent(sequent, { formulasOnly: true }).trim() : "";
	}
	/**
	 * Utility function, returns the sequent associated to this tree item
	 */
	getSequent (): SequentDescriptor {
		return this.sequent;
	}
	/**
	 * Utility function, updates the status of the tree item
	 */
	updateStatus (status: ProofNodeStatus): void {
		switch (status) {
			case "active": { this.active(); break; }
			case "visited": { this.visited(); break; }
			case "not-visited": { this.notVisited(); break; }
			case "pending": { this.pending(); break; }
			case "complete": { this.complete(); break; }
			case "not-complete": { this.notComplete(); break; }
			default: {
				console.warn(`[vscode-proof-explorer] Warning: unrecognized node status ${status}`);
			}
		}
	}
	/**
	 * Utility function, renames the tree item
	 */
	rename (name: string): void {
		this.name = name;
		this.label = this.name;
	}
	/**
	 * Utility function, updates the icon of the tree item based on the value of the status flags of the item
	 */
	protected updateIcon (): void {
		if (this.completeFlag) {
			if (this.contextValue === "root") {
				this.iconPath = {
					light: path.join(__dirname, "..", "..", "..", "icons", "svg-checkmark.svg"),
					dark: path.join(__dirname, "..", "..", "..", "icons", "svg-checkmark.svg")
				};
			} else {
				this.iconPath = {
					light: path.join(__dirname, "..", "..", "..", "icons", "svg-checkmark-round.svg"),
					dark: path.join(__dirname, "..", "..", "..", "icons", "svg-checkmark-round.svg")
				};
			}
		} else if (this.activeFlag) {
			this.iconPath = {
				light: path.join(__dirname, "..", "..", "..", "icons", "svg-blue-diamond.svg"),
				dark: path.join(__dirname, "..", "..", "..", "icons", "svg-blue-diamond.svg")
			};	
		} else if (this.pendingFlag) {
			this.iconPath = {
				light: path.join(__dirname, "..", "..", "..", "icons", "svg-star-gray.svg"),
				dark: path.join(__dirname, "..", "..", "..", "icons", "svg-star.svg")
			};	
		} else if (this.visitedFlag) {
			this.iconPath = {
				light: path.join(__dirname, "..", "..", "..", "icons", "star-gray.png"),
				dark: path.join(__dirname, "..", "..", "..", "icons", "star.png")
			};	
		} else {
			this.iconPath = {
				light: path.join(__dirname, "..", "..", "..", "icons", "svg-dot-gray.svg"),
				dark: path.join(__dirname, "..", "..", "..", "icons", "svg-dot-white.svg")
			};	
		}
	}
	/**
	 * Flags the tree item as complete
	 */
	complete (): void {
		this.completeFlag = true;
		this.updateIcon();
	}
	/**
	 * Flags the tree item as not complete
	 */
	notComplete (): void {
		this.completeFlag = false;
		this.updateIcon();
	}
	/**
	 * Flags the tree item as pending
	 */
	pending (): void {
		this.label = this.name;
		this.activeFlag = false;
		this.visitedFlag = false;
		this.pendingFlag = true;
		this.completeFlag = false; // pending automatically removes complete flag
		// this.noChangeFlag = false;
		this.updateIcon();
		// this.iconPath = {
		// 	light: path.join(__dirname, "..", "..", "..", "icons", "svg-star-gray.svg"),
        //     dark: path.join(__dirname, "..", "..", "..", "icons", "svg-star.svg")
        // };
	}
	/**
	 * Flags the tree item as visited
	 */
	visited (): void {
		this.label = this.name;
		this.activeFlag = false;
		this.visitedFlag = true;
		this.pendingFlag = false;
		// this.noChangeFlag = false;
		this.updateIcon();
		// this.iconPath = {
        //     light: path.join(__dirname, "..", "..", "..", "icons", "star-gray.png"),
        //     dark: path.join(__dirname, "..", "..", "..", "icons", "star.png")
        // };
	}
	/**
	 * Flags the tree item as not visited
	 */
	notVisited (): void {
		this.label = this.name;
		this.activeFlag = false;
		this.visitedFlag = false;
		this.pendingFlag = false;
		this.completeFlag = false; // not visited automatically resets complete flag -- see implementation of proof explorer in the server
		// this.noChangeFlag = false;
		this.updateIcon();
		// this.iconPath = {
        //     light: path.join(__dirname, "..", "..", "..", "icons", "svg-dot-gray.svg"),
        //     dark: path.join(__dirname, "..", "..", "..", "icons", "svg-dot-white.svg")
        // };
	}
	/**
	 * Flags the tree item as active
	 */
	active (): void {
		this.label = this.name;
		this.activeFlag = true;
		this.visitedFlag = false;
		this.pendingFlag = false;
		// this.noChangeFlag = false;
		vscode.commands.executeCommand("proof-explorer.reveal-node", { id: this.nodeId, name: this.name });
		this.updateIcon();
		// this.iconPath = {
        //     light: path.join(__dirname, "..", "..", "..", "icons", "svg-blue-diamond.svg"),
        //     dark: path.join(__dirname, "..", "..", "..", "icons", "svg-blue-diamond.svg")
        // };
	}
	/**
	 * Returns true if a tree item is complete
	 */
	isComplete(): boolean { return this.completeFlag; }
	/**
	 * Returns true if a tree item is active
	 */
	isActive (): boolean { return this.activeFlag; }
	/**
	 * Returns true if a tree item is visited or pending
	 */
	isVisitedOrPending (): boolean { return this.visitedFlag || this.pendingFlag; }
	/**
	 * Returns true if a tree item is pending
	 */
	isPending (): boolean { return this.pendingFlag; }
	/**
	 * Returns true if a tree item is visited
	 */
	isVisited (): boolean { return this.visitedFlag; }
	/**
	 * Utility function, replaces the children of the tree item with the provided array of children
	 */
	setChildren (children: ProofItem[]): void {
		this.children = children;
	}
	/**
	 * Utility function, deletes the given child from the tree item
	 */
	deleteChild (child: ProofItem): void {
		this.children = this.children.filter((ch: ProofItem) => {
			return ch.nodeId !== child.nodeId;
		});
		if (this.contextValue !== "root" && this.children.length === 0) {
			this.collapsibleState = TreeItemCollapsibleState.None;
		}
	}
	/**
	 * Utility function, returns the list of proof commands 
	 * for this tree item and all the tree items included in the subtree rooted this tree item
	 */
	getProofCommands (): ProofItem[] {
		let ans: ProofItem[] = [ this ];
		if (this.children) {
			for (let i = 0; i < this.children.length; i++) {
				ans = ans.concat(this.children[i].getProofCommands());
			}
		}
		return ans;
	}
	/**
	 * Utility function, returns a string containing the proof commands 
	 * for this tree item and all the tree items included in the subtree rooted this tree item
	 */
	 printProofCommands (opt?: { markExecuted?: boolean }): string | null {
		opt = opt || {};
		if (opt.markExecuted) {
			this.iconPath = {
				light: path.join(__dirname, "..", "..", "..", "icons", "star-gray.png"),
				dark: path.join(__dirname, "..", "..", "..", "icons", "star.png")
			};
		}
		let ans: string = (this.contextValue === "proof-command") ? this.name : "";
		if (this.children && this.children.length) {
			for (let i = 0; i < this.children.length; i++) {
				ans += this.children[i].printProofCommands(opt);
			}
		}
		return ans;
	}
	/**
	 * Utility function, appends a child to the tree item
	 */
	appendChild (child: ProofItem): void {
		this.children = this.children || [];
		child.parent = this;
		if (child.contextValue === "root") {
			this.children = this.children.concat(child.children);
		} else {
			this.children.push(child);
		}
		// keep children ordered by name
		this.children = this.children.sort((a: ProofItem, b: ProofItem): number => {
			// we need to compare number rather than strings, otherwise the order is incorrect (e.g., "10" is < "2")
			const aa: number = +(a.branchId.split(".").slice(-1));  
			const bb: number = +(b.branchId.split(".").slice(-1));  
			return (aa < bb) ? -1 : 1;
		});
		this.collapsibleState = TreeItemCollapsibleState.Expanded;
	}
	/**
	 * Utility function, returns the children of the tree item
	 */
	getChildren (): ProofItem[] {
		return this.children;
	}
	/**
	 * Utility function, serializes the tree item into an extended node structure (ProofNodeX)
	 */
	getNodeXStructure (): ProofNodeX {
		const res: ProofNodeX = {
			id: this.nodeId,
			branch: this.branchId,
			name: this.name,
			type: <ProofNodeType> this.contextValue,
			rules: [],
			parent: this.parent.nodeId
		};
		if (this.children) {
			for (let i = 0; i < this.children.length; i++) {
				const child: ProofNodeX = this.children[i].getNodeXStructure();
				res.rules.push({
					id: child.id,
					branch: child.branch,
					name: child.name,
					type: child.type,
					rules: child.rules,
					parent: this.nodeId
				});
			}
		}
		return res;
	}
	/**
	 * Utility function, returns the structur of this tree item and all the children included in the subtree rooted at this tree item
	 */
	getNodeStructure (): ProofNode {
		const res: ProofNode = {
			branch: this.branchId,
			name: this.name,
			type: <ProofNodeType> this.contextValue,
			rules: []
		};
		if (this.children) {
			for (let i = 0; i < this.children.length; i++) {
				const child: ProofNode = this.children[i].getNodeStructure();
				res.rules.push({
					branch: child.branch,
					name: child.name,
					type: child.type,
					rules: child.rules
				});
			}
		}
		return res;
	}
}
export class ProofCommand extends ProofItem {
	constructor (desc: { id?: string, cmd: string, branchId: string, parent: ProofItem, collapsibleState?: TreeItemCollapsibleState }) {
		super({ id: desc.id, type: "proof-command", name: desc.cmd, branchId: desc.branchId, parent: desc.parent, collapsibleState: desc.collapsibleState });
		const cmd: string = desc.cmd.trim();
		this.name = (cmd && cmd.startsWith("(") && cmd.endsWith(")")) || isUndoCommand(cmd) ? cmd : `(${cmd})`;
		this.notVisited();
		this.command = {
			title: this.contextValue,
			command: "proof-explorer.did-select-proof-command",
			arguments: [ this ]
		};
	}
}
export class ProofBranch extends ProofItem {
	constructor (desc: { id?: string, cmd: string, branchId: string, parent: ProofItem, collapsibleState?: TreeItemCollapsibleState }) {
		super({ id: desc.id, type: "proof-branch", name: desc.cmd, branchId: desc.branchId, parent: desc.parent, collapsibleState: desc.collapsibleState });
		this.name = `(${desc.branchId})`;
		this.notVisited();
		this.command = {
			title: this.contextValue,
			command: "proof-explorer.did-select-proof-branch",
			arguments: [ this ]
		};
	}
}
class WelcomeScreen extends TreeItem {
	constructor () {
		super("welcome-screen", TreeItemCollapsibleState.None);
		this.label = "Proof Explorer will become active when starting a proof";
	}
}
class LoadingItem extends TreeItem {
	contextValue: string = "loading-content";
	message: string = "Loading proof";
	id: string = fsUtils.get_fresh_id();
	protected points: number = 0;
	protected MAX_POINTS: number = 3;
	protected timer: NodeJS.Timer = null;
	constructor () {
		super ("loading-content", TreeItemCollapsibleState.None);
		this.label = this.message;
	}
	start (): Promise<void> {
		return new Promise ((resolve, reject) => {
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
export class RootNode extends ProofItem {
	proofStatus: ProofStatus; // this is updated while running the proof
	initialProofStatus: ProofStatus; // this is set at the beginning (and at the end of the proof attempt if the proof succeeds)
	constructor (desc: { id?: string, name: string, proofStatus?: ProofStatus }) {
		super({ id: desc.id, type: "root", name: desc.name, branchId: "", parent: null, collapsibleState: TreeItemCollapsibleState.Expanded });
		this.parent = this; // the parent of the root is the root itself
		this.proofStatus = desc.proofStatus || "untried"
		this.initialProofStatus = this.proofStatus;
		this.notVisited();
		this.tooltip = "";
		this.command = {
			title: this.contextValue,
			command: "proof-explorer.root-selected",
			arguments: [ this ]
		};
	}
	// @overrides
	// clone (parent?: RootNode): RootNode {
	// 	const c: RootNode = new RootNode({ name: this.name, proofStatus: this.proofStatus });
	// 	c.parent = parent || null;
	// 	c.pending();
	// 	return c;
	// }

	// @overrides
	notVisited (): void {
		// this.proofStatus = "untried";
		super.notVisited();
		this.updateLabel();
	}
	// @overrides
	visited (): void {
		// do nothing
	}
	// @overrides
	pending (): void {
		if (this.proofStatus === "untried") {
			this.proofStatus = "unfinished";
		}
		super.pending();
		this.updateLabel();
		this.iconPath = {
            light: path.join(__dirname, "..", "..", "..", "icons", "svg-orange-diamond.svg"),
            dark: path.join(__dirname, "..", "..", "..", "icons", "svg-orange-diamond.svg")
        };
	}
	QED (): void {
		super.visited();
		// this.icon = utils.icons.checkmark;
		this.proofStatus = QED;
		this.setProofStatus(QED);
		this.updateLabel();
		this.iconPath = {
            light: path.join(__dirname, "..", "..", "..", "icons", "svg-checkmark.svg"),
            dark: path.join(__dirname, "..", "..", "..", "icons", "svg-checkmark.svg")
		};
	}
	isQED (): boolean {
		return this.proofStatus === QED;
	}
	proofStatusChanged (): boolean {
		return this.initialProofStatus !== this.proofStatus;
	}
	setProofStatus (proofStatus: ProofStatus): void {
		if (proofStatus) {
			this.proofStatus = proofStatus;
			this.updateLabel();
		}
	}
	resetProofStatus (): void {
		this.proofStatus = this.initialProofStatus;
		this.updateLabel();
	}
	getProofStatus (): ProofStatus {
		return this.proofStatus;
	}
	protected updateLabel (): void {
		const proofStatus: ProofStatus = this.proofStatus || "untried";
		this.label = `${this.name} (${proofStatus})`; //`${this.icon}${this.name} (${proofStatus})`;
		// if (this.initialProofStatus === this.proofStatus) {
		// 	this.label = `${this.icon}${this.name} (${this.proofStatus})`;
		// } else {
		// 	this.label = `${this.icon}${this.name} (${this.initialProofStatus} - ${this.proofStatus})`;
		// }
	}
}
export class GhostNode extends ProofItem {
	realNode: ProofItem;
	constructor (desc: { id?: string, parent: ProofItem, node: ProofItem }) {
		super({ type: "ghost", name: "...", branchId: "", parent: desc.parent, collapsibleState: TreeItemCollapsibleState.None });
		this.realNode = desc.node;
		this.tooltip = "Awaiting new command...";
	}
	qed (): void {
		this.label = QED;
	}
	// @overrides
	active (): void {
		super.active();
		this.label = " ...";
	}
	notActive (): void {
		this.activeFlag = false;
		this.label = "";
	}
	// @overrides
	notVisited () {
		super.notVisited();
		this.label = "";
	}
	// // @overrides
	// moveIndicatorBack (): ProofItem {
	// 	this.notActive();
	// 	this.realNode.active();
	// 	return this.realNode;
	// }
	// // @overrides
	// moveIndicatorForward (): ProofItem {
	// 	return null;
	// }
	// @overrides
	// appendSibling (sib: ProofItem, opt?: { beforeSelected?: boolean }): void {
	// 	if (this.realNode.contextValue === "root") {
	// 		this.realNode.appendChild(sib);
	// 	} else {
	// 		this.realNode.appendSibling(sib, opt);
	// 	}
	// }
	// // @overrides
	// appendChildAtBeginning (child: ProofItem): void {
	// 	this.realNode.appendChildAtBeginning(child);
	// }
	// @overrides
	appendChild (child: ProofItem): void {
		this.realNode.appendChild(child);
	}
}

