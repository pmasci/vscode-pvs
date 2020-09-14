import * as fsUtils from "../server/src/common/fsUtils";
import { label, configFile } from './test-utils';
import * as path from 'path';
import { PvsLanguageServer } from '../server/src/pvsLanguageServer'
import { ProofDescriptor, ProofFile } from "../server/src/common/serverInterface";
import { execSync } from "child_process";
import * as constants from './test-constants';
import { PvsResult } from "../server/src/common/pvs-gui";
//----------------------------
//   Test cases for pvs language server
//----------------------------

describe("pvs-language-server", () => {
	let server: PvsLanguageServer = new PvsLanguageServer();
	beforeAll(async () => {
		const config: string = await fsUtils.readFile(configFile);
		const content: { pvsPath: string } = JSON.parse(config);
		// console.log(content);
		const pvsPath: string = content.pvsPath;
		await server.startPvsServer({ pvsPath });

		console.log("\n----------------------");
		console.log("test-pvs-language-server");
		console.log("----------------------");
	});
	afterAll(async () => {
	});

	// utility function, quits the prover if the prover status is active
	const quitProverIfActive = async (): Promise<void> => {
		// quit prover if prover status is active
		const proverStatus: PvsResult = await server.getPvsProxy().getProverStatus();
		expect(proverStatus.result).toBeDefined();
		expect(proverStatus.error).not.toBeDefined();
		console.log(proverStatus);
		if (proverStatus && proverStatus.result !== "inactive") {
			await server.getPvsProxy().proofCommand({ cmd: 'quit' });
		}
	}
	
	// OK
	it(`can load and save pvs proof (.prj)`, async () => {
		// remove alaris folder if present and replace it with the content of the zip file
		const baseFolder: string = path.join(__dirname, "pvs-language-server");
		// fsUtils.deleteFolder(path.join(baseFolder, "alaris2l"));
		// execSync(`cd ${path.join(__dirname, "pvscontext")} && unzip alaris2l-show-tccs-error.zip`);
		execSync(`cd ${path.join(baseFolder, "sq")} && rm -f sq.jprf`);

		const desc: ProofDescriptor = await server.loadProof({
			fileName: "sq", 
			fileExtension: ".pvs", 
			contextFolder: path.join(baseFolder, "sq"),
			theoryName: "sq",
			formulaName: "triangle_rectangle"
		});
		// console.dir(desc, { depth: null });
		expect(desc.info.theory).toEqual("sq");
		expect(desc.info.formula).toEqual("triangle_rectangle");
		expect(desc.info.status).toEqual("untried");
		expect(desc.info.prover).toContain("PVS");
		expect(desc.info.shasum).toEqual("90d0630453df76b0a749b92ac10e7e51b0c59e2cb0e3711bb009a7b4191b802a");

	}, 20000);

});

