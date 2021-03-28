import { Emitter } from '../libs/emitter.ts';
import { Player, PlayerData } from './player.ts';
import { World, WorldData, WorldGenerator } from './world/world.ts';

import * as event from './events.ts';
import { AuthData, Holder, Command, Group, Plugin, Nullable, XYZ } from './types.ts';
import { ConnectionHandler } from './networking/connection.ts';
import { setupGenerators } from './world/generators.ts';
import { semver } from './deps.ts';
import { blocks, blockIds, blocksIdsToName } from './world/blocks.ts';
import { setupCommands } from './commands.ts';

export class Server {
	readonly softwareName = 'Cobblestone';
	readonly softwareVersion = '0.0.3';
	readonly _apiVersion = '0.0.3';
	readonly _minimalApiVersion = '0.0.3';

	readonly files: IFileHelper;
	readonly logger: ILogger;
	readonly event = {
		PlayerConnect: new Emitter<event.PlayerConnect>(true),
		PlayerDisconnect: new Emitter<event.PlayerDisconnect>(true),
		PlayerChangeWorld: new Emitter<event.PlayerChangeWorld>(true),
		PlayerMove: new Emitter<event.PlayerMove>(true),
		PlayerColides: new Emitter<event.PlayerColides>(true),
		PlayerMessage: new Emitter<event.PlayerMessage>(true),
		PlayerTeleport: new Emitter<event.PlayerTeleport>(true),
		PlayerBlockBreak: new Emitter<event.PlayerChangeBlock>(true),
		PlayerBlockPlace: new Emitter<event.PlayerChangeBlock>(true),
		PlayerCommand: new Emitter<event.PlayerCommand>(true),
		ServerShutdown: new Emitter<Server>(),
		ServerLoadingFinished: new Emitter<Server>(),
		ServerCommandRegistration: new Emitter<Server>(),
	};

	readonly worlds: Holder<World> = {};
	readonly players: Holder<Player> = {};
	readonly _generators: Holder<WorldGenerator> = {};
	readonly _commands: Holder<Command> = {};
	readonly _plugins: Holder<Plugin> = {};
	readonly blocks = blocks;
	readonly blockIds = blockIds;
	readonly blockIdsToNames = blocksIdsToName;

	readonly groups: Holder<Group> = {};

	readonly classicTextRegex = /[^ -~]/gi;

	config: IConfig;

	_takenPlayerIds: number[] = [];

	_autoSaveInterval = -1;
	_autoBackupInterval = -1;

	_loaded = false;

	isShuttingDown = false;

	constructor(files: IFileHelper, logger: ILogger) {
		files.createBaseDirectories();

		logger.log(`&aStarting ${this.softwareName} ${this.softwareVersion} server...`);

		this.files = files;
		this.logger = logger;

		if (files.existConfig('config')) {
			const tmp = <IConfig>files.getConfig('config');
			this.config = { ...defaultConfig, ...tmp };
			(<Holder<string>>this.config.messages) = { ...defaultConfig.messages, ...(tmp.messages ?? {}) };
		} else {
			this.config = { ...defaultConfig };
		}

		if (files.existConfig('groups')) {
			this.groups = { ...(<Holder<Group>>files.getConfig('groups')) };
		} else {
			this.groups['default'] = { name: 'default', permissions: {} };
		}

		files.saveConfig('config', this.config);
		files.saveConfig('groups', this.groups);

		setupGenerators(this);

		this.loadWorld(this.config.defaultWorldName) ?? this.createWorld(this.config.defaultWorldName, [256, 128, 256], this._generators['grasslands']);

		Object.values(this.worlds).forEach((world) => {
			this.files.saveWorld(`backup/${world.fileName}-${this.formatDate(new Date())}`, world);
		});

		if (this.config.autoSaveInterval > 0) {
			this._autoSaveInterval = setInterval(() => {
				Object.values(this.worlds).forEach((world) => {
					this.saveWorld(world);
				});
			}, 1000 * 60 * this.config.autoSaveInterval);
		}
		if (this.config.autoSaveInterval > 0) {
			this._autoBackupInterval = setInterval(() => {
				Object.values(this.worlds).forEach((world) => {
					this.files.saveWorld(`backup/${world.fileName}-${this.formatDate(new Date())}`, world);
				});
			}, 1000 * 60 * this.config.backupInterval);
		}

		setupCommands(this);

		try {
			this.startLoadingPlugins(() => {
				this.event.ServerCommandRegistration._emit(this);
				try {
					this.startListening();
				} catch (e) {
					this.logger.error(e);
					this.stopServer();
				}

				logger.log('Server started!');

				this._loaded = true;
				this.event.ServerLoadingFinished._emit(this);
			});
		} catch (e) {
			this.logger.error('Error occured while loading plugins!');
			this.logger.error(e);

			this.stopServer();
		}
	}

	startListening() {}

	stopServer() {
		this.isShuttingDown = true;
		this.logger.log('&6Closing server...');
		this.files.saveConfig('config', this.config);
		this.files.saveConfig('groups', this.groups);
		this.event.ServerShutdown._emit(this);

		Object.values(this.players).forEach((player) => {
			player.disconnect('Server closed');
		});

		Object.values(this.worlds).forEach((world) => {
			this.saveWorld(world);
		});
	}

	connectPlayer(conn: ConnectionHandler, client?: string, overrides?: AuthData) {
		try {
			conn._server = this;
			this.logger.conn(`Connection from ${conn.ip}:${conn.port}...`);
			conn._clientPackets.PlayerIdentification.once(async ({ value: playerInfo }) => {
				conn.sendServerInfo(this);

				const result = await this.authenticatePlayer({
					uuid: overrides?.uuid ?? playerInfo.username.toLowerCase(),
					username: overrides?.username ?? playerInfo.username,
					service: overrides?.service ?? 'Minecraft',
					secret: overrides?.secret ?? playerInfo.key,
					authenticated: overrides?.authenticated ?? false,
				});

				if (result.allow) {
					this.logger.conn(
						result.auth.service == 'Unknown'
							? `User ${result.auth.username} (${result.auth.uuid}) doesn't use any auth...`
							: `User ${result.auth.username} (${result.auth.uuid}) is logged with ${result.auth.service} auth!`
					);

					const player = new Player(
						result.auth.uuid ?? 'offline-' + result.auth.username.toLowerCase(),
						result.auth.username,
						client ?? 'Classic',
						result.auth.service,

						conn,
						this
					);
					this.players[player.uuid] = player;

					player.changeWorld(player.world);
					this.sendChatMessage(this.getMessage('join', { player: player.getDisplayName() }), player);
				} else {
					conn.disconnect('You need to log in!');
				}
			});
		} catch (e) {
			this.logger.error('Disconnected player - ' + e);
			conn.disconnect(e);
		}
	}

	authenticatePlayer(data: AuthData): Promise<{ auth: AuthData; allow: boolean }> {
		return new Promise((r) => r({ auth: data, allow: true }));
	}

	executeCommand(command: string): boolean {
		const x = command.split(' ');
		if (this._commands[x[0]] != undefined) {
			this._commands[x[0]].execute({ server: this, player: null, command, send: this.logger.log, checkPermission: (x) => true });
			return true;
		}
		return false;
	}

	sendChatMessage(message: string, player?: Player) {
		Object.values(this.players).forEach((p) => p.sendMessage(message, player));

		this.logger.chat(message);
	}

	saveWorld(world: World): boolean {
		return this.files.saveWorld(world.name, world);
	}

	loadWorld(name: string): Nullable<World> {
		try {
			if (this.worlds[name] != undefined) {
				return this.worlds[name];
			} else {
				const data = this.files.getWorld(name);

				if (data != null) {
					const world = new World(name, data, this);
					this.worlds[name] = world;
					return world;
				}
				return null;
			}
		} catch (e) {
			this.logger.error(`Couldn't load world ${name}!`);
			this.logger.error(e);
			return null;
		}
	}

	unloadWorld(name: string): boolean {
		if (this.config.defaultWorldName == name) {
			return false;
		} else if (this.worlds[name] == undefined) {
			return true;
		} else {
			const x = this.saveWorld(this.worlds[name]);
			if (x) {
				delete this.worlds[name];
			}

			return x;
		}
	}

	createWorld(name: string, size: XYZ, generator: WorldGenerator, seed?: number, player?: Player): Nullable<World> {
		try {
			if (this.worlds[name] != undefined) {
				return this.worlds[name];
			}

			const world = new World(
				name.toLowerCase().replace(' ', '_'),
				{
					name,
					size,
					generator: { software: this.softwareName, type: generator.name },
					createdBy: {
						service: player?.service ?? 'Unknown',
						username: player?.service ?? `${this.softwareName} - ${generator.name}`,
					},
					spawnPoint: [size[0] / 2, size[1] / 2 + 20, size[2] / 2],
				},
				this
			);

			generator.generate(world);
			world.spawnPoint[1] = world.getHighestBlock(world.spawnPoint[0], world.spawnPoint[2], true);

			this.worlds[name] = world;

			this.saveWorld(world);

			return world;
		} catch (e) {
			this.logger.error(
				`Couldn't create world ${name} (size: ${size}, generator: ${generator?.name}, seed: ${seed ?? 0}, player: ${player?.username ?? null})!`
			);
			this.logger.error(e);
			return null;
		}
	}

	async addPlugin(plugin: Plugin, altid?: string): Promise<Nullable<Plugin>> {
		const textId = altid != undefined ? `${plugin.id} | ${altid}` : plugin.id;

		if (!plugin.id || !plugin.init || !plugin.version || !plugin.cobblestoneApi) {
			altid ? this.logger.warn(`Plugin ${altid ?? '!NOID'} isn't a valid plguin. Skipping...`) : null;
			return null;
		}

		try {
			const api = semver.valid(plugin.cobblestoneApi);
			if (api != null) {
				if (semver.gte(api, this._minimalApiVersion)) {
					if (semver.lte(api, this.softwareVersion)) {
						await plugin.init(this);

						this._plugins[plugin.id] = {
							...plugin,
							name: plugin.name ?? plugin.id,
							init: (x) => null,
						};

						return this._plugins[plugin.id];
					} else {
						this.logger.warn(`Plugin ${plugin.name} (${textId}) requires newer api version (${plugin.api}). Skipping...`);
						return null;
					}
				} else {
					this.logger.warn(`Plugin ${plugin.name} (${textId}) requires outdated api version (${plugin.api}). Skipping...`);
					return null;
				}
			}

			this.logger.warn(`Plugin ${plugin.name} (${textId}) declares usage of invalid api (${plugin.api}). Skipping...`);
			return null;
		} catch (e) {
			this.logger.error(`Loading plugin ${plugin.name} (${textId}) caused an exception!`);
			this.logger.error(e);
			return null;
		}
	}

	startLoadingPlugins(cb: () => void) {
		cb();
	}

	getPlugin(plugin: string): Nullable<Plugin> {
		return this._plugins[plugin] ?? null;
	}

	addCommand(command: Command): boolean {
		if (command.name.includes(' ')) {
			return false;
		}

		this._commands[command.name] = command;
		return true;
	}

	getCommand(command: string): Nullable<Command> {
		return this._commands[command] ?? null;
	}

	addGenerator(gen: WorldGenerator): boolean {
		this._generators[gen.name] = gen;
		return true;
	}

	getGenerator(gen: string): Nullable<WorldGenerator> {
		return this._generators[gen] ?? null;
	}

	getMessage(id: string, values: Holder<string>): string {
		let message = this.config.messages[id];

		if (message == undefined) {
			message = id;
		}

		for (const x in values) {
			message = message.replaceAll('$' + x.toUpperCase(), values[x]);
		}

		return message;
	}

	getPlayerIdFromName(username: string): Nullable<string> {
		return null;
	}

	static formatDate(date: number | Date, showTime = true): string {
		if (!(date instanceof Date)) {
			date = new Date(date);
		}

		return (
			`${date.getFullYear()}-${addZero(date.getMonth())}-${addZero(date.getDay())}` +
			(showTime ? `-${addZero(date.getHours())}-${addZero(date.getMinutes())}-${addZero(date.getSeconds())}` : '')
		);
	}

	formatDate = Server.formatDate;
}

function addZero(n: number): string {
	return n > 9 ? n.toString() : '0' + n;
}

export interface ILogger {
	log(text: string): void;
	error(text: string): void;
	warn(text: string): void;
	chat(text: string): void;
	conn(text: string): void;

	storedToFile: boolean;
}

export interface IFileHelper {
	saveConfig(namespace: string, config: unknown): boolean;
	getConfig(namespace: string): Nullable<unknown>;
	existConfig(namespace: string): boolean;

	saveWorld(name: string, world: World): boolean;
	getWorld(namespace: string): Nullable<WorldData>;
	existWorld(name: string): boolean;
	listWorlds(): string[];

	savePlayer(uuid: string, player: PlayerData): boolean;
	getPlayer(uuid: string): Nullable<PlayerData>;
	existPlayer(uuid: string): boolean;
	listPlayers(): string[];

	createBaseDirectories(): void;
}

export interface IConfig {
	address: string;
	port: number;
	voxelSrvPort: number;

	serverName: string;
	serverMotd: string;

	maxPlayerCount: number;
	autoSaveInterval: number;
	backupInterval: number;

	defaultWorldName: string;

	useMineOnlineHeartbeat: boolean;
	classicOnlineMode: boolean;
	publicOnMineOnline: boolean;

	VoxelSrvOnlineMode: boolean;
	publicOnVoxelSrv: boolean;
	allowOffline: boolean;

	VoxelSrvUseWSS: boolean;
	VoxelSrvWssOptions: { key: string, cert: string },


	messages: {
		join: string;
		leave: string;
		chat: string;
		serverStopped: string;
		noCommand: string;
		cheatDistance: string;
		cheatTile: string;
		cheatClick: string;
		cheatSpam: string;
		[i: string]: string;
	};
}

const defaultConfig: IConfig = {
	address: 'localhost',
	port: 25566,
	voxelSrvPort: 25567,

	serverName: 'Cobblestone',
	serverMotd: 'Another Minecraft Classic server!',

	maxPlayerCount: 20,
	autoSaveInterval: 5,
	backupInterval: 1440,

	defaultWorldName: 'main',

	useMineOnlineHeartbeat: false,
	classicOnlineMode: false,
	publicOnMineOnline: false,

	VoxelSrvOnlineMode: false,
	publicOnVoxelSrv: false,
	allowOffline: true,

	VoxelSrvUseWSS: false,
	VoxelSrvWssOptions: { key: '', cert: '' },

	messages: {
		join: '&e$PLAYER joined the game',
		leave: '&e$PLAYER left the game',
		chat: '&f<$PLAYER> $MESSAGE',
		noCommand: "&cThis command doesn't exist or you don't have access to it",
		serverStopped: 'Server stopped!',
		cheatDistance: 'Cheat detected: Distance',
		cheatTile: 'Cheat detected: Tile type',
		cheatClick: 'Cheat detected: Too much clicking!',
		cheatSpam: "You've spammed too much",
	},
};
