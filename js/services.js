'use strict';

/* Services */
angular.module('portfolio.services', ['ngResource']).
	factory('Work', function($resource){
		return $resource('data.json', {}, {
			query: {method:'GET', isArray:true}
		});
	});