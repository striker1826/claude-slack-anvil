module.exports = {
	apps: [
		{
			name: 'peaktree-anvil',
			script: 'index.js',
			instances: 1,
			exec_mode: 'fork',
			watch: false,
			env: {
				NODE_ENV: 'production',
			},
		},
	],
};
