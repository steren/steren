var filterGroups = ['seriousness', 'type', 'participation']; //'completion',

var data = [
		{
			id:'beansight',
			completion: 'wip',
			seriousness:'serious',
			type:'code',
			participation:'full',
			title:'Beansight',
			category:'web',
			date: 2010,
			description:'Co-founder of a web start-up that predicts the future.',
			links: [{href:'http://www.beansight.com', value:'beansight.com'}]
		},
		{
			id:'divelog',
			completion: 'wip',
			seriousness:'serious',
			type:'code',
			participation:'full',
			title:'Open Dive Log',
			category:'web',
			date: 2010,
			description:'Founder of a web portal for scuba diving lovers.',
			links: [{href:'http://labs.steren.fr/category/open-divers/', value:'blog'}]
		},
		{
			id:'cadeaux',
			completion: 'wip',
			seriousness:'not-so-serious',
			type:'code',
			participation:'full',
			title:'Cadeaux entre nous',
			category:'web',
			date: 2010,
			description:'Small website to offer presents on an original way.',
			links: [{href:'http://www.cadeaux-entre-nous.fr', value:'cadeaux-entre-nous.fr'}]
		},
		{
			id:'swym',
			completion: 'done',
			seriousness:'serious',
			type:'code',
			participation:'contribution',
			title:'SwYm',
			category:'web',
			date: 2010,
			description:'Development for an innovative social platform at Dassault Systèmes: Wiki, search-related features and front-end widgets.',
			links: [{href:'http://swym.3ds.com', value:'swym.3ds.com'}]
		},
		{
			id:'remixthem',
			completion: 'done',
			seriousness:'not-so-serious',
			type:'code',
			participation:'full',
			title:'RemixThem',
			category:'Android application',
			date: 2009,
			description:'Automatically mix and remix faces from pictures.',
			links: [{href:'http://remixthem.steren.fr', value:'remixthem.steren.fr'}]
		},
		{
			id:'stroke',
			completion: 'done',
			seriousness:'serious',
			type:'code',
			participation:'full',
			title:'Stroke',
			category:'3D software',
			date: 2009,
			description:'Technological research at Dassault Systèmes: Interactive painting and sculpting on 3D models.'
		},
		{
			id:'capoda',
			completion: 'done',
			seriousness:'serious',
			type:'graphic',
			participation:'full',
			title:'CAPODA',
			category:'Animation',
			date: 2008,
			description:'A 3 minute computer generated short movie.',
			links: [{href:'http://www.vimeo.com/989180', value:'CAPODA on Vimeo'}]
		},
		{
			id:'inkscape',
			completion: 'done',
			seriousness:'serious',
			type:'code',
			participation:'contribution',
			title:'Inkscape',
			category:'Graphic software',
			date: 2008,
			description:'Envelope Live Path Effect, Live Path Effects stacking and Live Path Effects for groups of shapes.',
			links: [{href:'http://www.inkscape.org', value:'inkscape.org'}]
		},
		{
			id:'chauffeur',
			completion: 'done',
			seriousness:'not-so-serious',
			type:'graphic',
			participation:'full',
			title:'Le Chauffeur a des gants',
			category:'Short movie',
			date: 2008,
			description:'',
			links: [{href:'http://www.youtube.com/watch?v=A-N2Y4jnDg0', value:'Le Chauffeur a des gants on Youtube'}]
		},
		{
			id:'starwarspi',
			completion: 'done',
			seriousness:'not-so-serious',
			type:'graphic',
			participation:'full',
			title:'Star Wars : Episode π',
			category:'Short movie',
			date: 2008,
			description:'A Star Wars fan film.',
			links: [{href:'http://www.youtube.com/watch?v=Tgwii6yOxeI', value:'Star Wars : Episode π on Youtube'}]
		},
		{
			id:'alchemy',
			completion: 'done',
			seriousness:'serious',
			type:'code',
			participation:'contribution',
			title:'Alchemy',
			category:'Graphic software',
			date: 2009,
			description:'SVG export for Alchemy.',
			links: [{href:'http://al.chemy.org/news/alchemy-008-beta-release/', value:'Alchemy 008 Beta Release'}]
		},
		{
			id:'jambon',
			completion: 'done',
			seriousness:'stupid',
			type:'graphic',
			participation:'full',
			title:'The Attack Of The Jambon Volant',
			category:'Short movies',
			date: 2008,
			description:'Absurd american trailer parodies',
			links: [{href:'http://www.youtube.com/view_play_list?p=1EF78AC82296661C', value:'Episodes as a Youtube playlist'}
				//,
				//{href:'http://www.youtube.com/watch?v=_qOPk4TKBwY', value:'The Attack Of The Jambon Volant 2 on Youtube'},
				//{href:'http://www.youtube.com/watch?v=-c4UzbL7J-o', value:'The Attack Of The Jambon Volant 3 on Youtube'},
				//{href:'http://www.youtube.com/watch?v=QoSFuK3qAW4', value:'Jambon Volant: Origins on Youtube'}
				]
		},
		{
			id:'trezinlove',
			completion: 'done',
			seriousness:'stupid',
			type:'graphic',
			participation:'full',
			title:'Trez in Love',
			category:'Short movie',
			date: 2008,
			description:'Parody of american music videos.',
			links: [{href:'http://www.youtube.com/watch?v=4u0loF_Usec', value:'Trez in Love on Youtube'}]
		},
		{
			id:'holytupperware',
			completion: 'done',
			seriousness:'stupid',
			type:'graphic',
			participation:'full',
			title:'The Holy Tupperware',
			category:'Short movies',
			date: 2004,
			description:'',
			links: [{href:'http://www.youtube.com/view_play_list?p=E144529EA9F01696', value:'Episodes as a Youtube playlist'}
				//,
				//{href:'http://www.youtube.com/watch?v=kOG3ntVKZ-A', value:'La Richetonite on Youtube'},
				//{href:'http://www.youtube.com/watch?v=BcVWSW74upQ', value:'Le Prophète on Youtube'},
				//{href:'http://www.youtube.com/watch?v=8BiPmFglzjY', value:'La Communauté on Youtube'},
				//{href:'http://www.youtube.com/watch?v=Kqe0m8Z5NLQ', value:'Finalité finale on Youtube'}
				]
		},
		{
			id:'tpe',
			completion: 'done',
			seriousness:'serious',
			type:'graphic',
			participation:'full',
			title:'TPE Energie Nucléaire',
			category:'Educational film',
			date: 2004,
			description:'Short videos and serious game around the nuclear energy.',
			links: [{href:'http://www.youtube.com/view_play_list?p=BF471ABDA0ABD278', value:'Videos as a Youtube playlist'}]
		},
		{
			id:'mobileinfantry',
			completion: 'done',
			seriousness:'serious',
			type:'graphic',
			participation:'contribution',
			title:'Mobile Infantry',
			category:'Half-life Mod',
			date: 2002,
			description:'Level Design for an Half Life modification based on the Starship Troopers universe.',
			links: [{href:'http://www.youtube.com/watch?v=1LC1Ud0rVnI', value:'Mobile Infantry - Training Camp on Youtube'}]
		}
		
];
