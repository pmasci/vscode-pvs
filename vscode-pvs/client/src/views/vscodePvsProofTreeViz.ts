/**
 * @module vscodePvsProofTreeViz
 * @author Paolo Masci
 * @date 2021.01.13
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

import * as vscode from 'vscode';
import * as d3 from 'd3';
import { ProofItem, RootNode } from "./vscodePvsProofExplorer";
import Handlebars = require("handlebars");
import { ExtensionContext, WebviewPanel } from 'vscode';
import { ProofNodeStatus } from '../common/serverInterface';
import * as path from 'path';

export type d3Iterable<T> = (node: T) => void;
export interface d3HierarchyNode<T>{
    x: number,
    y: number,
    parent?: d3HierarchyNode<T>,
    children?: d3HierarchyNode<T>[],
    data: T,
    each: (iterable: d3Iterable<d3HierarchyNode<T>>) => void,
    depth?: number, // distance from the root node. height = 0 for the root node
    height?: number // greatest distance from any descendant. height = 0 for leaf nodes
};

export interface TreeStructure {
    id?: string,
    name?: string,
    status?: {
        visited: boolean,
        pending: boolean,
        complete: boolean,
        active: boolean
    },
    children?: TreeStructure[],
    parent?: TreeStructure,
    depth?: number, // distance from the root node. height = 0 for the root node
    height?: number // greatest distance from any descendant. height = 0 for leaf nodes
};

export const green: string = '#7ac142';

const htmlTemplate: string = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{title}}</title>
    {{#each css}}
    <link rel="stylesheet" href="{{this}}">
    {{/each}}
    {{#each js}}
    <script src="{{this}}"></script>
    {{/each}}
    <!--<link rel="stylesheet" 
        href="https://cdn.jsdelivr.net/npm/bootstrap@4.5.3/dist/css/bootstrap.min.css" 
        integrity="sha384-TX8t27EcRE3e/ihU7zmQxVncDAy5uIKz4rEkgIXeMed4M0jlfIDPvg6uqKI2xXr2" 
        crossorigin="anonymous">-->
    <style type="text/css">
        .node {
            cursor: pointer;
            fill: white;
            stroke: darkgray;
        }
        .node .checkmark {
            stroke: transparent;
        }
        .node .star {
            stroke: transparent;
            fill: transparent;
        }
        .node:hover {
            cursor: pointer;
            stroke: steelblue;
        }
        .node.active {
            fill: steelblue !important;
            stroke: steelblue !important;
        }
        .node.active circle {
            fill: steelblue !important;
            stroke: steelblue !important;
            animation: pulser 2s linear infinite !important;
        }
        .node.active .star {
            fill: transparent !important;
            stroke: transparent !important;
        }
        .node.visited {
            fill: transparent;
            stroke: transparent;
        }
        .node.visited .star {
            fill: steelblue;
            stroke: steelblue;
        }
        .node.complete {
            fill: ${green};
            stroke: darkgray;
        }
        .node.complete .checkmark {
            stroke: white;
        }
        .node.complete .star {
            fill: transparent;
            stroke: transparent;
        }
        .node.pending {
            fill: transparent;
            stroke: transparent;
        }
        .node.pending .star {
            fill: white;
            stroke: steelblue;
        }
        .node text {
            font: 10px sans-serif;
            fill: darkslateblue;
            stroke: transparent;
        }
        .spacer {
            display: none;
        }
        .link {
            fill: none;
            stroke: #ccc;
            stroke-width: 1.5px;
        }          
        @keyframes pulser {
            0% {
                opacity: 1;
            }
            70% {
                opacity: 0.6;
            }
        }
    </style>
</head>
<body style="margin-left:20px; margin-top:60px; padding:0; overflow:auto; background:whitesmoke;">
    <nav class="navbar navbar-light bg-dark fixed-top" style="width:100%; margin:0; padding:0;">
        <div class="container-fluid">
        <div class="btn-toolbar container-fluid" role="toolbar" aria-label="Toolbar with button groups" style="transform:scale(0.8);">
            <div class="btn-group" role="group">
                <button type="button" class="btn btn-sm btn-outline-warning" aria-label="Zoom minus" id="zoom-minus"><i class="fa fa-minus"></i></button>
                <button type="button" class="btn btn-sm btn-outline-light" aria-label="Zoom plus" id="zoom-plus"><i class="fa fa-plus"></i></button>
            </div>
            <div class="btn-group" role="group">
                <button type="button" id="prev" class="btn btn-sm btn-outline-light" alt="Back one step" aria-label="Back one step" style="width:80px;"><i class="fa fa-step-backward"></i></button>
                <button type="button" id="play" class="btn btn-sm btn-outline-light" alt="Run proof" aria-label="Run proof" style="width:40px;"><i class="fa fa-play-circle"></i></button>
                <button type="button" id="next" class="btn btn-sm btn-outline-light" alt="Step proof" aria-label="Step proof" style="width:80px;"><i class="fa fa-step-forward"></i></button>
            </div>
            <div class="btn-group" role="group">
                <button id="recenter" class="btn btn-sm btn-outline-light" aria-label="Recenter" type="button">Recenter</button>
            </div>
        </div>
    </nav>
    <div id="content">
        <svg id="proof-tree" style="width:{{width}}px; height:{{height}}px;">
            <g class="links">
            {{#each links}}
                <g class="link {{source.data.id}}">
                    <line x1="{{source.x}}" y1="{{source.y}}" x2="{{target.x}}" y2="{{target.y}}"></line>
                </g>
            {{/each}}
            </g>
            <g class="nodes">
            {{#each nodes}}
                {{#if @first}}
                <g id={{data.id}} class="node{{#if data.status.visited}} visited{{/if}}{{#if data.status.pending}} pending{{/if}}{{#if data.status.active}} active{{/if}}{{#if data.status.complete}} complete{{/if}}" transform="translate({{x}},{{y}})">
                    <circle class="root-node" r="1"></circle>
                    <text dy="-1em" text-anchor="middle">Proof: {{data.name}}</text>
                </g>
                {{else}}
                <g id={{data.id}} class="node{{#if data.status.visited}} visited{{/if}}{{#if data.status.pending}} pending{{/if}}{{#if data.status.active}} active{{/if}}{{#if data.status.complete}} complete{{/if}}" transform="translate({{x}},{{y}})">
                    <circle r="6"></circle>
                    <path class="checkmark" fill="none" d="M-3 0l2 3 6-6"></path>
                    <path class="star" d="M0 -6l1.379 4.246h4.465l-3.612 2.625 1.379 4.246-3.611-2.625-3.612 2.625 1.379-4.246-3.612-2.625h4.465l1.38-4.246"></path>
                    <rect y="-1.1em" x="-0.4em" width="0.8em" height="0.6em" style="fill:whitesmoke; fill-opacity:0.6; stroke:transparent;"></rect>
                    <text class="name" dy="-1em" text-anchor="middle">{{data.name}}</text>
                </g>
                {{/if}}
            {{/each}}
            </g>
        </svg>
    </div>
    <script>
    // utility functions to send messages to vscode-pvs from the webview
    (function() {
        const vscode = acquireVsCodeApi();

        $("#recenter").on("click", (evt) => {
            vscode.postMessage({ command: 'recenter' });
        });
        $("#zoom-minus").on("click", (evt) => {
            vscode.postMessage({ command: 'zoom-minus' });
        });
        $("#zoom-plus").on("click", (evt) => {
            vscode.postMessage({ command: 'zoom-plus' });
        });
        $("#next").on("click", (evt) => {
            vscode.postMessage({ command: 'next' });
        });
        $("#prev").on("click", (evt) => {
            vscode.postMessage({ command: 'prev' });
        });
        $("#play").on("click", (evt) => {
            vscode.postMessage({ command: 'play' });
        });
    }());
    // Handle the message inside the webview
    window.addEventListener('message', event => {
        const message = event.data; // JSON data sent by vscode-pvs
        if (message) {
            const node = document.getElementById(message.id);
            switch (message.command) {
                case 'active': {
                    if (node) {
                        // only one node should be active
                        const all = document.getElementsByClassName("node");
                        for (let i = 0; i < all?.length; i++) {
                            all[i].classList?.remove("active");
                        }
                        node.classList?.add("active");
                        node.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
                    }
                    break;
                }
                case 'pending': {
                    if (node) {
                        node.classList?.remove("visited");
                        node.classList?.add("pending");
                        node.classList?.remove("complete");
                    }
                    break;
                }
                case 'visited': {
                    if (node) {
                        node.classList?.add("visited");
                        node.classList?.remove("pending");
                        node.classList?.remove("complete");
                    }
                    break;
                }
                case 'not-visited': {
                    if (node) {
                        node.classList?.remove("visited");
                        node.classList?.remove("pending");
                        node.classList?.remove("complete");
                    }
                    break;
                }
                case 'complete': {
                    if (node) {
                        node.classList?.remove("visited");
                        node.classList?.remove("pending");
                        node.classList?.add("complete");
                    }
                    break;
                }
                case 'not-complete': {
                    if (node) {
                        node.classList?.remove("complete");
                    }
                    break;
                }
                case 'rename': {
                    if (node && node.name) {
                        $("#" + node + " .name").html(node.name);
                    }
                    break;
                }
                // other commands
                case 'zoom': {
                    if (message?.scale) {
                        $("#content").css({
                            transform: "scale(" + message.scale + ")",
                            "transform-origin": "top left",
                            transition: "500ms ease-out"
                        });
                    }
                    break;
                }
                case 'recenter': {
                    const $active = $(".active");
                    if ($active[0]) {
                        $active[0].scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
                    }
                    break;
                }
                default: {
                    break;
                }
            }
        }
    });
    </script>
</body>
</html>`

export type LayoutNode = d3HierarchyNode<TreeStructure>;
export type LayoutLink = { source: LayoutNode, target: LayoutNode };

const MAX_NAME_LEN: number = 32;

export class LayoutFactory {
    protected depth: number = 0;
    protected span: number = 0;
    protected width: number = 0;
    protected height: number = 0;
    protected hsep: number = MAX_NAME_LEN; //px
    protected vsep: number = 32; //px
    protected layout: d3HierarchyNode<TreeStructure>;
    protected nodes: LayoutNode[] = [];
    protected links: LayoutLink[] = [];
    
    readonly marginTop: number = 20;

    clearLayout (): void {
        this.depth = 0;
        this.span = 0;
        this.width = 0;
        this.height = 0;
        this.nodes = [];
        this.links = [];
    }

    convert (item: ProofItem): TreeStructure {
        if (item) {
            const ans: TreeStructure = {
                id: item.id,
                name: item.name,
                status: {
                    complete: item.isComplete(),
                    visited: item.isVisited(),
                    active: item.isActive(),
                    pending: item.isPending()
                }
            };
            let root: TreeStructure = ans;
            let parent: TreeStructure = ans;
            if (item.children?.length) {
                for (let i = 0; i < item.children.length; i++) {
                    // ProofItems are encoded in a compact way: the first child is a child, the others are descendents
                    // the parent of child(i) is child(i-1)
                    if (i > 0 && item.children[i].contextValue !== "proof-branch") {
                        parent = root.children[root.children.length - 1];
                        root = parent;
                    }
                    parent.children = parent.children || [];
                    parent.children.push(this.convert(item.children[i]));
                }
            } else {
                this.span++;
            }
            return ans;
        }
        return null;
    }

	createLayout (item: ProofItem): d3HierarchyNode<TreeStructure> {
        this.clearLayout();
        const structure: TreeStructure = { children: [ this.convert(item) ] }; // this is done to add some space on top, otherwise the root node would be out of the view
        const root: LayoutNode = d3.hierarchy(structure);
        if (root) {
            this.depth = root.height;
            this.width = this.span * this.hsep;
            this.height = this.depth * this.vsep;
            const d3Layout = d3.tree().size([ this.width, this.height]);
            this.layout = d3Layout(root);

            root?.each((node: LayoutNode) => {
                if (node.data?.name) {
                    if (node.data.name?.length > MAX_NAME_LEN) {
                        node.data.name = node.data.name.substring(0, MAX_NAME_LEN) + "...";
                    }
                    this.nodes.push(node);
                    if (node.parent?.data?.name) {
                        this.links.push({ source: node.parent, target: node });
                    }
                }
            });
        }
        return this.layout;
    }

	getLayout (): d3HierarchyNode<TreeStructure> { return this.layout; }
	getDepth (): number { return this.depth; }
    getSpan (): number { return this.span; }
    getWidth (): number { return this.width; }
    getHeight (): number { return this.height; }
    getNodes (): LayoutNode[] { return this.nodes; }
    getLinks (): LayoutLink[] { return this.links; }
}

export class VSCodePvsVizTree {
    protected layout: LayoutFactory;
    protected panel: WebviewPanel;
    protected context: ExtensionContext;

    protected zoomLevel: number = 100;
    readonly minZoomLevel: number = 1;
    readonly maxZoomLevel: number = 1000;
    readonly zoomStep: number = 20;
    protected visible: boolean = false;

    constructor () {
        this.layout = new LayoutFactory();
    }
    activate(context: ExtensionContext): void {
        this.context = context;
    }
    reveal (): void {
        this.visible = true;
        this.panel.reveal()
    }
    hide (): void {
        this.panel.dispose();
        this.visible = false;
    }
    recenter (): void {
        this.panel?.webview?.postMessage({
            command: "recenter"
        });
    }
    zoomMinus (): void {
        this.zoomLevel = this.zoomLevel - this.zoomStep < this.minZoomLevel ? this.minZoomLevel : this.zoomLevel - this.zoomStep;
        const scale = this.zoomLevel / 100;
        this.panel?.webview?.postMessage({
            command: "zoom",
            scale
        });
    }
    zoomPlus(): void {
        this.zoomLevel = this.zoomLevel + this.zoomStep > this.maxZoomLevel ? this.maxZoomLevel : this.zoomLevel + this.zoomStep;
        const scale: number = this.zoomLevel / 100;
        this.panel?.webview?.postMessage({
            command: "zoom",
            scale
        });
    }
    async render (root: RootNode, opt?: { reveal?: boolean, recenter?: boolean }): Promise<boolean> {
        opt = opt || {};
        this.visible = opt.reveal !== undefined ? !!opt.reveal : this.visible;
        return new Promise((resolve, reject) => {
            if (root && this.visible) {
                // create webview
                if (!this.panel) {
                    this.panel = vscode.window.createWebviewPanel(
                        'proof-tree', // Identifies the type of the webview. Used internally
                        `Proof: ${root.name}`, // Title of the panel displayed to the user
                        vscode.ViewColumn.Beside, // Editor column to show the new webview panel in.
                        {
                            enableScripts: true
                        }
                    );
                    // Clean up data structures when webview is disposed
                    this.panel.onDidDispose(
                        () => {
                            this.panel = null;
                            this.visible = false;
                        },
                        null,
                        this.context.subscriptions
                    );
                    // Handle messages from the webview
                    this.panel.webview.onDidReceiveMessage(
                        message => {
                            switch (message.command) {
                                case 'recenter': {
                                    this.recenter();
                                    break;
                                }
                                case 'zoom-minus': {
                                    this.zoomMinus();
                                    break;
                                }
                                case 'zoom-plus': {
                                    this.zoomPlus();
                                    break;
                                }
                                case 'next': {
                                    vscode.commands.executeCommand("proof-explorer.forward");
                                    break;
                                }
                                case 'prev': {
                                    vscode.commands.executeCommand("proof-explorer.back");
                                    break;
                                }
                                case 'play': {
                                    vscode.commands.executeCommand("proof-explorer.run-proof");
                                    break;
                                }
                                default: {
                                    break;
                                }
                            }
                        },
                        undefined,
                        this.context.subscriptions
                    );
                }

                // set webview content                
                const bootstrapJsOnDisk: vscode.Uri = vscode.Uri.file(path.join(this.context.extensionPath, 'client/node_modules/bootstrap/dist/js/bootstrap.bundle.min.js'));
                const bootstrapCssOnDisk: vscode.Uri = vscode.Uri.file(path.join(this.context.extensionPath, 'client/node_modules/bootstrap/dist/css/bootstrap.min.css'));
                const jqueryOnDisk: vscode.Uri = vscode.Uri.file(path.join(this.context.extensionPath, 'client/node_modules/jquery/dist/jquery.min.js'));
                const fontawesomeCssOnDisk: vscode.Uri = vscode.Uri.file(path.join(this.context.extensionPath, 'client/node_modules/font-awesome/css/font-awesome.min.css'));

                const css = [
                    this.panel.webview.asWebviewUri(bootstrapCssOnDisk),
                    this.panel.webview.asWebviewUri(fontawesomeCssOnDisk)
                ];
                const js = [
                    this.panel.webview.asWebviewUri(jqueryOnDisk), // jquery needs to be loaded before bootstrap
                    this.panel.webview.asWebviewUri(bootstrapJsOnDisk)
                ];
                this.panel.webview.html = this.createHtmlContent(root, { css, js });
                if (opt.recenter) {
                    this.recenter();
                }
                resolve(true);
            }
        });
    }
    rename (id: string, name: string): void {
        if (id) {
            this.panel?.webview?.postMessage({ command: "rename", id, name });
        }
    }
    active (id: string): void {
        if (id) {
            this.panel?.webview?.postMessage({ command: "active", id });
        }
    }
    visited (id: string): void {
        if (id) {
            this.panel?.webview?.postMessage({ command: "visited", id });
        }
    }
    notVisited (id: string): void {
        if (id) {
            this.panel?.webview?.postMessage({ command: "not-visited", id });
        }
    }
    pending (id: string): void {
        if (id) {
            this.panel?.webview?.postMessage({ command: "pending", id });
        }
    }
    complete (id: string): void {
        if (id) {
            this.panel?.webview?.postMessage({ command: "complete", id });
        }
    }
    notComplete (id: string): void {
        if (id) {
            this.panel?.webview?.postMessage({ command: "not-complete", id });
        }
    }
    updateStatus (desc: { id: string, status: ProofNodeStatus }): void {
        if (desc && this.visible) {
            switch (desc.status) {
                case "active": { this.active(desc.id); break; }
                case "visited": { this.visited(desc.id); break; }
                case "not-visited": { this.notVisited(desc.id); break; }
                case "pending": { this.pending(desc.id); break; }
                case "complete": { this.complete(desc.id); break; }
                case "not-complete": { this.notComplete(desc.id); break; }
                default: {
                    console.warn(`[vscode-viz-tree] Warning: unrecognized node status ${desc.status}`);
                }
            }
        }
	}
    createHtmlContent (root: RootNode, opt?: { css?: vscode.Uri[], js?: vscode.Uri[] }): string {
        this.layout.createLayout(root);
        const nodes: LayoutNode[] = this.layout.getNodes();
        const links: LayoutLink[] = this.layout.getLinks();
        const height: number = this.layout.getHeight();
        const width: number = this.layout.getWidth();
        const html: string = Handlebars.compile(htmlTemplate, { noEscape: true })({
            title: root?.name,
            nodes,
            links,
            width: width * 1.1,
            height: height * 1.1,
            ...opt
        });
        return html;
    }
}